import { flushDirectory } from '@canopy/core-platform/directory-flush';
import { type W5ServiceHistoryRelocation } from '@canopy/core-runtime/node/w5/service-history';
import type { W5ReceiptStore } from '@canopy/core-runtime/node/w5/keyed-operation';
import path from 'node:path';
import {
  createCoreEventsModule,
  type PlatformOperatingSystem,
  type RuntimeModule,
  type RuntimeService,
} from '@canopy/core-runtime';
import {
  createW5CommitEventSource,
  type W5CommitEventHost,
  type W5CommitEventSource,
} from '@canopy/core-runtime/node/w5/commit-events';
import { createW5DaemonCommitLogHost } from '@canopy/core-runtime/node/w5/daemon-host-composition';
import type { W5CommitLogHostPort } from '@canopy/core-runtime/node/w5/commit-log-file-store';
import {
  CORE_WORKSPACE_CHANGED_EVENT,
  CORE_WORKSPACE_EVENT_FAMILY,
} from '@canopy/protocol/canopy-core';
import {
  companionDirectory,
  daemonHostLocation,
  daemonOwnedChildAddon as daemonW5ConfinementAddon,
} from './companion-paths';
import { DAEMON_W5_HOST_SERVICE } from './w5-host-health';
import { DAEMON_W5_WORKER_FILE } from './w5-worker-file';

/*
 * The daemon's W5 commit log host (W5b, CAN-5450). Every build carries it
 * (CAN-5529); daemon.ts loads it for activated ownership or `--w5-host v1`,
 * and constructs it only after it holds the startup claim.
 * It registers no W5 operation (the W6g record port, W5d1's hosted metadata
 * commands and W7 do). daemon.ts opens the log eagerly, before the graph: a
 * log another process holds degrades that daemon to no W5 host. Given the
 * runtime's epoch it also composes the W5e commit events (CAN-5497): the
 * `core.events` module over a journal of the host's applied commits. On win32
 * its worker reads captures through the owned-child addon beside the worker
 * bundle (CAN-5530); without one that loads, capture refuses with
 * `confinement-unavailable`.
 */
export type DaemonW5HostStop = 'stopped' | 'unconfirmed';

export interface DaemonW5HostOptions {
  /** The daemon's verified canonical data root. */
  readonly canonicalDataRoot: string;
  readonly os: PlatformOperatingSystem;
  /**
   * Awaited before every worker start; resolves only while the startup
   * claim or the published endpoint protects this data root.
   */
  readonly admission: () => Promise<void>;
  /** Defaults to `daemonW5WorkerEntry()`. */
  readonly workerEntry?: string;
  /** The runtime's `daemonEpoch`; given, the host composes commit events. */
  readonly daemonEpoch?: string;
  /** Defaults to `daemonW5ConfinementAddon()`. */
  readonly confinementAddon?: string;
  /** CAN-5786 must supply journal-qualified destination admission, never client data. */
  readonly serviceHistoryRelocation?: W5ServiceHistoryRelocation;
  readonly getReceiptStore?: (store: W5ReceiptStore) => W5ReceiptStore;
}

export interface DaemonW5Host {
  /** Owner-qualified lookup-only projections; no wire-supplied historical hashes. */
  readonly getReceiptStore?: (store: W5ReceiptStore) => W5ReceiptStore;
  /**
   * The raw calls a W5 store makes; its identity keys the shared decision
   * queue. With events composed, the W6g record port goes through
   * `events.port(...)` views of it instead, so every commit it applies is
   * published once.
   */
  readonly port: W5CommitLogHostPort;
  /**
   * W5e: the commit event source. A module serving a client passes
   * `events.port({ publishedBy: caller.clientInstanceId })`, so that client's
   * own subscriber skips the events of commits it publishes itself.
   * `publishedBy` means that origin already ran its post-commit work; a
   * module whose commits no process followed up, as W5d1's hosted metadata
   * commands, commits through the plain `events.port()`.
   */
  readonly events?: W5CommitEventSource;
  /** Modules the graph composes with this host: W5e's `core.events`. */
  readonly modules?: readonly RuntimeModule[];
  /** Stops the host in phase 7. */
  readonly service: RuntimeService;
  /**
   * Starts the worker, which opens the log and runs launch recovery. Rejects
   * with the log's `W5CommitLogError` when it cannot open it.
   */
  open(): Promise<void>;
  /**
   * Stops the host; repeated calls share one shutdown. `unconfirmed` while a
   * stopped worker may still hold the log.
   */
  stop(): Promise<DaemonW5HostStop>;
}

export type CreateDaemonW5Host = (options: DaemonW5HostOptions) => DaemonW5Host;

/**
 * The worker bundle beside the executable, or beside the entry script of a
 * bundled run. A tsx source run has none, so its W5 host refuses to start.
 */
export function daemonW5WorkerEntry(location = daemonHostLocation()): string {
  return path.join(companionDirectory(path, location), DAEMON_W5_WORKER_FILE);
}

// Kept for W5 callers; Trash resolves the same daemon-side companion.
export { daemonOwnedChildAddon as daemonW5ConfinementAddon } from './companion-paths';
export type { DaemonLocation as DaemonW5Location } from './companion-paths';

/**
 * W5e's commit events over a host port: the source whose views W5 modules
 * commit through, and the `core.events` module serving its journal.
 */
export function composeDaemonW5Events(
  host: W5CommitEventHost,
  daemonEpoch: string,
): Pick<Required<DaemonW5Host>, 'events' | 'modules'> {
  const events = createW5CommitEventSource({ host, epoch: daemonEpoch });
  return {
    events,
    modules: [
      createCoreEventsModule({
        journal: events.journal,
        families: [CORE_WORKSPACE_EVENT_FAMILY],
        // The web core's refetch signal; this host's commit events carry it.
        unserved: [CORE_WORKSPACE_CHANGED_EVENT],
      }),
    ],
  };
}

export const createDaemonW5Host: CreateDaemonW5Host = (options) => {
  const host = createW5DaemonCommitLogHost({
    canonicalDataRoot: options.canonicalDataRoot,
    os: options.os,
    workerEntry: options.workerEntry ?? daemonW5WorkerEntry(),
    confinementAddon: options.confinementAddon ?? daemonW5ConfinementAddon(),
    admission: options.admission,
    syncDirectory: flushDirectory,
    serviceHistoryRelocation: options.serviceHistoryRelocation,
  });
  // One shutdown; each call rechecks, so a late exit confirms a later call.
  const stop = async (): Promise<DaemonW5HostStop> => {
    await host.shutdown();
    return host.runningWorkerCount === 0 ? 'stopped' : 'unconfirmed';
  };
  return {
    port: host,
    ...(options.getReceiptStore && {
      getReceiptStore: options.getReceiptStore,
    }),
    ...(options.daemonEpoch !== undefined &&
      composeDaemonW5Events(host, options.daemonEpoch)),
    open: async (): Promise<void> => {
      await host.recoveryReport();
    },
    service: {
      name: DAEMON_W5_HOST_SERVICE,
      plane: 'core',
      required: true,
      stop: {
        7: async (): Promise<void> => {
          if ((await stop()) !== 'stopped')
            throw new Error('The W5 commit log worker has not exited.');
        },
      },
    },
    stop,
  };
};
