'use client';

import { useEffect, useMemo, useState } from 'react';
import type {
  CanopyClient,
  InstalledItemsChangedEvent,
} from '@canopy/app-core';
import type {
  InstalledItemSnapshot,
  InstalledItemTarget,
} from '@canopy/protocol/installed-items';
import {
  useInstalledItemStatuses,
  type InstalledItemSnapshotState,
  type InstalledItemStatusController,
  type InstalledItemStatusSource,
} from '@canopy/ui-shared';

const LOADING: InstalledItemSnapshotState = { kind: 'loading' };

/**
 * The error code a portable adapter gives a host on a release without the
 * installed-item channels (`REMOTE_HOST_OUTDATED_CODE` in
 * `@canopy/ipc-canopy-client`, which this package does not depend on).
 */
const HOST_OUTDATED_CODE = 'remote_host_outdated';

/**
 * The host's update message when it refused an operation because its release
 * is too old, or null for any other failure.
 */
export function hostOutdatedMessage(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  return Reflect.get(error, 'code') === HOST_OUTDATED_CODE &&
    error.message.trim() !== ''
    ? error.message
    : null;
}

export interface InstalledItemStatusSourceOptions {
  /** Called when the host refuses the read because its release is too old. */
  readonly onHostOutdated?: (message: string) => void;
  /**
   * Called with the targets an uninstall's result names as removed, only
   * when the host answered; never for a failed or unanswered request.
   */
  readonly onRemoved?: (removed: readonly InstalledItemTarget[]) => void;
  /** Per subscriber: schedule a read, or reuse a read for the same mutation. */
  readonly onStatusChange?: (
    event: InstalledItemsChangedEvent,
    refresh: () => Promise<boolean>,
  ) => void;
}

/**
 * Adapts a {@link CanopyClient} to the shared {@link InstalledItemStatusSource}
 * (CAN-7442). Reads coalesce: while one read is in flight, any number of
 * further requests share a single trailing read, so a burst of
 * `installedItems.changed` pushes costs at most two reads.
 */
export function installedItemStatusSourceFromClient(
  client: CanopyClient,
  options: InstalledItemStatusSourceOptions = {},
): InstalledItemStatusSource {
  let inFlight: Promise<InstalledItemSnapshot> | null = null;
  let trailing: Promise<InstalledItemSnapshot> | null = null;
  const start = (): Promise<InstalledItemSnapshot> => {
    const read = client
      .query('installedItems.listStatus', {})
      .catch((error: unknown) => {
        const outdated = hostOutdatedMessage(error);
        if (outdated !== null) options.onHostOutdated?.(outdated);
        throw error;
      });
    inFlight = read;
    const clear = (): void => {
      if (inFlight === read) inFlight = null;
    };
    void read.then(clear, clear);
    return read;
  };
  return {
    listStatus() {
      const current = inFlight;
      if (current === null) return start();
      trailing ??= current
        .then(
          () => undefined,
          () => undefined,
        )
        .then(() => {
          trailing = null;
          return start();
        });
      return trailing;
    },
    setStatus: (request) => client.command('installedItems.setStatus', request),
    uninstall: async (request) => {
      const result = await client.command('installedItems.uninstall', request);
      if (result.removed.length > 0) options.onRemoved?.(result.removed);
      return result;
    },
    subscribe: (refresh) =>
      client.subscribe('installedItems.changed', (event) => {
        if (options.onStatusChange === undefined) void refresh();
        else options.onStatusChange(event, refresh);
      }),
  };
}

export interface UseClientInstalledItemStatusesInput extends Pick<
  InstalledItemStatusSourceOptions,
  'onStatusChange'
> {
  /** The host client, or null when the page has none to read from. */
  readonly client: CanopyClient | null;
  /** Shown while the host can't serve status. */
  readonly unsupportedReason: string;
  /**
   * Changes whenever the host's capabilities may have changed or its
   * connection reopened: the hook re-reads the capability then, and takes a
   * fresh snapshot, since pushes were missed while the connection was down.
   */
  readonly generation: string;
  /**
   * See {@link InstalledItemStatusSourceOptions.onRemoved}. Keep its identity
   * stable: a new callback rebuilds the source and reads the snapshot again.
   */
  readonly onRemoved?: (removed: readonly InstalledItemTarget[]) => void;
}

/**
 * Installed-item status through a {@link CanopyClient} (CAN-7442). It is
 * read-only with `unsupportedReason` while `installedItemStatus` is off, and
 * read-only with the host's update message once a host on an older release
 * refuses the read; that refusal is not retried until `generation` changes.
 * Uninstall is offered only when `canUninstall` is true.
 */
export function useClientInstalledItemStatuses({
  client,
  unsupportedReason,
  generation,
  onRemoved,
  onStatusChange,
}: UseClientInstalledItemStatusesInput): InstalledItemStatusController & {
  readonly canUninstall: boolean;
} {
  const statusOn = client?.capabilities.installedItemStatus === true;
  const canUninstall =
    statusOn && client?.capabilities.installedItemUninstall === true;
  const [outdated, setOutdated] = useState<{
    readonly client: CanopyClient;
    readonly generation: string;
    readonly message: string;
  } | null>(null);
  const outdatedMessage =
    outdated !== null &&
    outdated.client === client &&
    outdated.generation === generation
      ? outdated.message
      : null;
  const source = useMemo(
    () =>
      client !== null && statusOn && outdatedMessage === null
        ? installedItemStatusSourceFromClient(client, {
            onHostOutdated: (message) =>
              setOutdated({ client, generation, message }),
            onRemoved,
            onStatusChange,
          })
        : null,
    // `generation` rebuilds the source, so a reopened connection reads again.
    [client, statusOn, outdatedMessage, generation, onRemoved, onStatusChange],
  );
  const reason = outdatedMessage ?? unsupportedReason;
  const controller = useInstalledItemStatuses(source, reason);
  // The shared hook resets its state for a new source in an effect, so the
  // render that swaps sources (another computer, a reopened connection)
  // still carries the old one's snapshot. Until that reset lands, report the
  // new source's starting state, so no caller reads one computer's snapshot
  // as another's.
  const [stateSource, setStateSource] = useState(source);
  useEffect(() => {
    setStateSource(source);
  }, [source]);
  const state: InstalledItemSnapshotState =
    stateSource === source
      ? controller.state
      : source !== null
        ? LOADING
        : { kind: 'unsupported', reason };
  const { pendingKeys, refresh, refreshAndReport, setStatus, uninstall } =
    controller;
  return useMemo(
    () => ({
      state,
      pendingKeys,
      refresh,
      refreshAndReport,
      setStatus,
      uninstall,
      canUninstall,
    }),
    [
      state,
      pendingKeys,
      refresh,
      refreshAndReport,
      setStatus,
      uninstall,
      canUninstall,
    ],
  );
}
