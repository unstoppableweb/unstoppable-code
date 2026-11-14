import { useCanopyClient } from '@canopy/app-state';
import type { CanopyClient } from '@canopy/app-core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BaseBranchPickerBranchState } from './BaseBranchPicker';

const BRANCH_LOAD_ERROR = "Couldn't load branches.";
const UNSUPPORTED: BaseBranchPickerBranchState = { kind: 'unsupported' };
const LOADING: BaseBranchPickerBranchState = { kind: 'loading' };

interface LoadedBranches {
  scope: {
    client: CanopyClient;
    target: string | null;
    sessionId: string | null;
  };
  state: BaseBranchPickerBranchState;
}

export interface WorktreeBaseBranches {
  /** Picker state for the current workspace; `unsupported` when disabled. */
  state: BaseBranchPickerBranchState;
  /** Re-reads the list; a failed read shows loading while it retries. */
  refresh: () => void;
}

/**
 * Lists the branches a new worktree in `workspaceId` can start from. Pass
 * `enabled: false` when the target lacks branch-base support or is not a
 * single-repository workspace. A scope change drops unsent reads and
 * ignores responses from the previous scope.
 */
export function useWorktreeBaseBranches({
  workspaceId,
  enabled,
  sessionId = null,
}: {
  workspaceId: string | undefined;
  enabled: boolean;
  sessionId?: string | null;
}): WorktreeBaseBranches {
  const client = useCanopyClient();
  const target = enabled && workspaceId ? workspaceId : null;
  // A reconnect to the same workspace is a new read scope too. Comparing
  // identities prevents the previous connection's catalog painting even once.
  const scope = useMemo(
    () => ({ client, target, sessionId }),
    [client, target, sessionId],
  );
  const [loaded, setLoaded] = useState<LoadedBranches | null>(null);
  const generation = useRef(0);
  const inFlight = useRef<LoadedBranches['scope'] | null>(null);
  const submittedRead = useRef<Promise<void>>(Promise.resolve());

  const load = useCallback((): void => {
    if (target === null || inFlight.current === scope) return;
    inFlight.current = scope;
    const requestId = ++generation.current;
    setLoaded({ scope, state: LOADING });
    // Keep at most one catalogue command on the Portal transport. Skip
    // requests that became obsolete while waiting for that command.
    submittedRead.current = submittedRead.current.then(
      async (): Promise<void> => {
        if (generation.current !== requestId) return;
        try {
          const result = await client.query('worktree.baseBranches', {
            workspaceId: target,
          });
          if (generation.current !== requestId) return;
          setLoaded({
            scope,
            state: result.supported
              ? {
                  kind: 'ready',
                  branches: result.branches,
                  ...(result.truncated ? { truncated: true } : {}),
                }
              : UNSUPPORTED,
          });
        } catch {
          if (generation.current !== requestId) return;
          setLoaded({
            scope,
            state: { kind: 'error', message: BRANCH_LOAD_ERROR },
          });
        } finally {
          if (generation.current === requestId) inFlight.current = null;
        }
      },
    );
  }, [client, target, scope]);

  useEffect(() => {
    load();
    return (): void => {
      generation.current += 1;
      inFlight.current = null;
    };
  }, [load]);

  const current = loaded !== null && loaded.scope === scope ? loaded : null;
  const state: BaseBranchPickerBranchState =
    target === null ? UNSUPPORTED : (current?.state ?? LOADING);
  return { state, refresh: load };
}
