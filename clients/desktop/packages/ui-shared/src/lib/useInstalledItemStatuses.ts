'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  InstalledItemMutationResult,
  InstalledItemStatus,
  InstalledItemTarget,
  InstalledItemUninstallTarget,
} from '@canopy/protocol/installed-items';
import {
  deviceServerDeletedWithIncompleteCleanup,
  findInstalledItem,
  installedItemTargetKey,
  type InstalledItemMutationOutcome,
  type InstalledItemSnapshotState,
  type InstalledItemStatusController,
  type InstalledItemStatusSource,
} from './installed-item-status';

const READ_FAILED = 'Status could not be loaded. Refresh to try again.';
const MUTATION_UNCONFIRMED =
  'The change is not confirmed. Refresh the status or try again.';

function mutationOutcome(
  result: InstalledItemMutationResult,
  target: InstalledItemTarget,
): InstalledItemMutationOutcome {
  const item = findInstalledItem(result.snapshot, target);
  const notices = item?.notices ?? [];
  if (result.success && result.errors.length === 0)
    return { ok: true, notices };
  const message = result.errors
    .map((error) => error.message)
    .filter((text) => text.length > 0)
    .join(' ');
  return {
    ok: false,
    message: message.length > 0 ? message : MUTATION_UNCONFIRMED,
    notices,
    ...(deviceServerDeletedWithIncompleteCleanup(result, target)
      ? { cleanupIncomplete: true }
      : {}),
  };
}

/**
 * Loads the host's installed-item snapshot, refetches on host change events,
 * and refetches after mutations. Every read takes a sequence number, so a
 * slow earlier read never overwrites a newer state. Mutation responses may
 * arrive out of order, so their snapshots never replace authoritative reads.
 * Pass `null` with a reason on hosts that cannot manage status.
 */
export function useInstalledItemStatuses(
  source: InstalledItemStatusSource | null,
  unsupportedReason = 'Status is unavailable here.',
): InstalledItemStatusController {
  const [state, setState] = useState<InstalledItemSnapshotState>(
    source
      ? { kind: 'loading' }
      : { kind: 'unsupported', reason: unsupportedReason },
  );
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const sequenceRef = useRef(0);
  const sourceGenerationRef = useRef(0);
  const pendingRef = useRef(new Set<string>());

  const load = useCallback((): void => {
    if (!source) return;
    const sequence = ++sequenceRef.current;
    source.listStatus().then(
      (snapshot) => {
        if (sequence !== sequenceRef.current) return;
        setState({ kind: 'ready', snapshot });
      },
      () => {
        if (sequence !== sequenceRef.current) return;
        setState({ kind: 'error', message: READ_FAILED });
      },
    );
  }, [source]);

  useEffect(() => {
    sourceGenerationRef.current += 1;
    pendingRef.current = new Set();
    setPendingKeys(new Set());
    if (!source) {
      sequenceRef.current += 1;
      setState({ kind: 'unsupported', reason: unsupportedReason });
      return undefined;
    }
    setState({ kind: 'loading' });
    load();
    const unsubscribe = source.subscribe?.(load);
    return (): void => {
      // Invalidate in-flight reads for a source that is going away.
      sequenceRef.current += 1;
      sourceGenerationRef.current += 1;
      unsubscribe?.();
    };
  }, [source, unsupportedReason, load]);

  const run = useCallback(
    async (
      target: InstalledItemTarget,
      mutate: (
        current: InstalledItemStatusSource,
      ) => Promise<InstalledItemMutationResult>,
    ): Promise<InstalledItemMutationOutcome> => {
      if (!source)
        return { ok: false, message: unsupportedReason, notices: [] };
      const key = installedItemTargetKey(target);
      const generation = sourceGenerationRef.current;
      // One mutation per item: a repeated click is ignored, not queued.
      if (pendingRef.current.has(key))
        return { ok: false, message: MUTATION_UNCONFIRMED, notices: [] };
      pendingRef.current.add(key);
      setPendingKeys(new Set(pendingRef.current));
      try {
        const result = await mutate(source);
        // A replaced source or an unmounted consumer must not refetch, but the
        // host did complete this mutation; report its real outcome so callers
        // such as Uninstall can still leave a detail whose item is gone.
        if (generation === sourceGenerationRef.current) load();
        return mutationOutcome(result, target);
      } catch (error) {
        if (generation === sourceGenerationRef.current) load();
        // Fixed copy: a caught message can quote paths. The caught error
        // stays on a non-enumerable `cause` for local debugging.
        const outcome: InstalledItemMutationOutcome = {
          ok: false,
          message: MUTATION_UNCONFIRMED,
          notices: [],
        };
        Object.defineProperty(outcome, 'cause', {
          value: error,
          enumerable: false,
        });
        return outcome;
      } finally {
        if (generation === sourceGenerationRef.current) {
          pendingRef.current.delete(key);
          setPendingKeys(new Set(pendingRef.current));
        }
      }
    },
    [source, unsupportedReason, load],
  );

  const setStatus = useCallback(
    (target: InstalledItemTarget, status: InstalledItemStatus) =>
      run(target, (current) => current.setStatus({ target, status })),
    [run],
  );
  const uninstall = useCallback(
    (target: InstalledItemUninstallTarget) =>
      run(target, (current) => current.uninstall({ target })),
    [run],
  );

  return { state, pendingKeys, refresh: load, setStatus, uninstall };
}
