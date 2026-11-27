import { useEffect, useState } from 'react';
import { isPairedComputerId } from '@canopy/protocol/authority-qualified-id';
import type { ActivityFileDiffResponse } from '@canopy/desktop-shared/types';
import type {
  FileDiffContext,
  ReviewDiffIdentity,
} from '@canopy/desktop-shared/types/code-review';
import { useActivityStore } from '@/stores/activityStore';

export interface FileDiffSnapshot {
  data: ActivityFileDiffResponse;
  identity: ReviewDiffIdentity;
}

/** A turn comparison reads only the turn's own trees. */
export function isTurnDiffUnavailable(
  context: FileDiffContext | undefined,
): boolean {
  return context?.source === 'turn' && (!context.startTree || !context.endTree);
}

/**
 * Cancel stale responses and fingerprint the actual displayed bytes, not a
 * mutable Git label. A turn without both trees reads nothing:
 * {@link isTurnDiffUnavailable}.
 */
export function useFileDiffSnapshot(
  projectId: string,
  worktreeId: string,
  context: FileDiffContext | undefined,
  enabled: boolean,
  revision: number,
): { snapshot: FileDiffSnapshot | null; error: string | null } {
  const changedFiles = useActivityStore(
    (state) => state.changedFiles[`${projectId}/${worktreeId}`],
  );
  const [result, setResult] = useState<{
    key: string;
    snapshot: FileDiffSnapshot | null;
    error: string | null;
  }>({ key: '', snapshot: null, error: null });
  const paired =
    isPairedComputerId(projectId) || isPairedComputerId(worktreeId);
  const key = JSON.stringify([projectId, worktreeId, context]);
  useEffect(() => {
    if (!enabled || !context || paired) return;
    const request = {
      projectId,
      worktreeId,
      filePath: context.path,
      repoId: context.repoId,
    };
    const { startTree, endTree } = context;
    const promise =
      context.source !== 'turn'
        ? window.api.activity.getFileDiff({
            ...request,
            source: context.source,
          })
        : startTree && endTree
          ? window.api.activity.getTurnFileDiff({
              ...request,
              startTree,
              endTree,
            })
          : null;
    if (!promise) return;
    let cancelled = false;
    setResult({ key, snapshot: null, error: null });
    void promise
      .then(async (data) => {
        const digest = await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(
            JSON.stringify([
              context,
              data.oldValue,
              data.newValue,
              data.imagePreview,
            ]),
          ),
        );
        const snapshotId = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('');
        if (!cancelled)
          setResult({
            key,
            error: null,
            snapshot: {
              data: {
                ...data,
                source: context.source === 'turn' ? 'combined' : context.source,
              },
              identity: {
                source: context.source,
                snapshotId,
                previousPath: context.previousPath,
                startTree: context.startTree,
                endTree: context.endTree,
              },
            },
          });
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setResult({
            key,
            snapshot: null,
            error:
              error instanceof Error ? error.message : "Couldn't load changes.",
          });
      });
    return (): void => {
      cancelled = true;
    };
    // The serialized key includes every comparison field, while avoiding object-identity reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, revision, changedFiles]);
  return result.key === key ? result : { snapshot: null, error: null };
}
