import { useCallback, useEffect, useRef, useState } from 'react';
import type { CanopyClient } from '@canopy/app-core';
import type { RemoteControlWorktreeBranchesListResult } from '@canopy/protocol/remote-control/shell';
import { useCanopyClient } from '../CanopyClientProvider';

export type BaseBranchCatalogueStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface UseBaseBranchCatalogueOptions {
  readonly workspaceId: string | null;
  /** The host's gate (capability, workspace type, refusal); false clears. */
  readonly enabled: boolean;
}

export interface UseBaseBranchCatalogueResult {
  readonly status: BaseBranchCatalogueStatus;
  /** The last completed catalogue for {@link catalogueWorkspaceId}. */
  readonly catalogue: RemoteControlWorktreeBranchesListResult | null;
  /**
   * The workspace {@link catalogue} was read for. It can trail the requested
   * workspace for one render, so compare before deriving anything from it.
   */
  readonly catalogueWorkspaceId: string | null;
  /** The last failed read; a failed refresh keeps the prior catalogue. */
  readonly error: unknown;
  /** Re-reads unless a read is in flight, the hook is disabled or no workspace is set. */
  readonly refresh: () => void;
}

interface CatalogueState {
  readonly status: BaseBranchCatalogueStatus;
  readonly catalogue: RemoteControlWorktreeBranchesListResult | null;
  readonly catalogueWorkspaceId: string | null;
  readonly error: unknown;
}

const IDLE: CatalogueState = {
  status: 'idle',
  catalogue: null,
  catalogueWorkspaceId: null,
  error: null,
};

/**
 * New Task's branch bases for one workspace (`worktree.baseBranches`). Reads
 * when enabled and on each workspace change, drops answers that arrive after
 * the workspace changes, the hook is disabled or the consumer unmounts.
 */
export function useBaseBranchCatalogue(
  options: UseBaseBranchCatalogueOptions,
): UseBaseBranchCatalogueResult {
  const client = useCanopyClient();
  return useBaseBranchCatalogueWithClient(client, options);
}

/** {@link useBaseBranchCatalogue} with an explicit client, for hosts outside the provider. */
export function useBaseBranchCatalogueWithClient(
  client: CanopyClient,
  { workspaceId, enabled }: UseBaseBranchCatalogueOptions,
): UseBaseBranchCatalogueResult {
  const [state, setState] = useState<CatalogueState>(IDLE);
  // A workspace change, a disable and an unmount each advance the generation.
  const generationRef = useRef(0);
  const inFlightRef = useRef(false);
  const target = enabled && workspaceId ? workspaceId : null;
  const targetRef = useRef<string | null>(target);
  targetRef.current = target;

  const read = useCallback(
    (requested: string): void => {
      const generation = generationRef.current;
      inFlightRef.current = true;
      setState((previous) => ({ ...previous, status: 'loading' }));
      client.query('worktree.baseBranches', { workspaceId: requested }).then(
        (catalogue) => {
          if (generationRef.current !== generation) return;
          inFlightRef.current = false;
          setState({
            status: 'ready',
            catalogue,
            catalogueWorkspaceId: requested,
            error: null,
          });
        },
        (error: unknown) => {
          if (generationRef.current !== generation) return;
          inFlightRef.current = false;
          setState((previous) =>
            previous.catalogueWorkspaceId === requested
              ? { ...previous, status: 'error', error }
              : {
                  status: 'error',
                  catalogue: null,
                  catalogueWorkspaceId: null,
                  error,
                },
          );
        },
      );
    },
    [client],
  );

  useEffect(() => {
    generationRef.current += 1;
    inFlightRef.current = false;
    setState(IDLE);
    if (target !== null) read(target);
    return (): void => {
      generationRef.current += 1;
      inFlightRef.current = false;
    };
  }, [read, target]);

  const refresh = useCallback((): void => {
    const requested = targetRef.current;
    if (requested === null || inFlightRef.current) return;
    read(requested);
  }, [read]);

  return {
    status: state.status,
    catalogue: state.catalogue,
    catalogueWorkspaceId: state.catalogueWorkspaceId,
    error: state.error,
    refresh,
  };
}
