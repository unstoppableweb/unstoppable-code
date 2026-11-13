/**
 * Durable fork provenance for a local container (CAN-2552).
 *
 * Reads the record main wrote next to the destination worktree or Work Entry
 * rather than carrying the fork response around in renderer state. Provenance
 * has to survive a restart. It is the only thing left tying an independent
 * local container back to the share it came from, and the source can be
 * revoked at any time, so the file is the source of truth, not a store.
 *
 * Every non-forked container in the app would ask this question, so a `null`
 * answer is the overwhelmingly common one and must stay silent: no error
 * state, no toast, nothing rendered.
 */
import { useEffect, useState } from 'react';
import type { SharedContainerForkProvenance } from '@canopy/desktop-shared/types';
import { isWebCoreScope } from '@/lib/chat-authority';

export interface SharedContainerForkProvenanceState {
  readonly provenance: SharedContainerForkProvenance | null;
  /**
   * The read for the current container has finished, whatever it found. The
   * fork focus request waits for this before falling back to the header
   * (CAN-4782).
   */
  readonly settled: boolean;
}

function containerKey(projectId: string, worktreeId: string): string {
  return JSON.stringify([projectId, worktreeId]);
}

export function useSharedContainerForkProvenance(
  projectId: string | null,
  worktreeId: string | null,
): SharedContainerForkProvenanceState {
  const [provenance, setProvenance] =
    useState<SharedContainerForkProvenance | null>(null);
  const [settledKey, setSettledKey] = useState<string | null>(null);

  useEffect(() => {
    if (projectId === null || worktreeId === null) {
      setProvenance(null);
      setSettledKey(null);
      return;
    }
    const key = containerKey(projectId, worktreeId);
    // Shared-container forks are local; a cloud task is never one.
    if (isWebCoreScope(projectId)) {
      setProvenance(null);
      setSettledKey(key);
      return;
    }
    let canceled = false;
    void window.api.sharedContainers
      .readForkProvenance({ projectId, worktreeId })
      .then((record) => {
        if (canceled) return;
        setProvenance(record);
        setSettledKey(key);
      })
      .catch(() => {
        // A missing or unreadable record is indistinguishable from "this is
        // not a fork" as far as the UI is concerned, and neither is worth
        // interrupting the user over.
        if (canceled) return;
        setProvenance(null);
        setSettledKey(key);
      });
    return (): void => {
      canceled = true;
    };
  }, [projectId, worktreeId]);

  return {
    provenance,
    settled:
      projectId !== null &&
      worktreeId !== null &&
      settledKey === containerKey(projectId, worktreeId),
  };
}
