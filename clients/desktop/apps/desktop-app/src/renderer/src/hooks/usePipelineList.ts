import {
  artifactInventoryScope,
  observeArtifactPipelines,
  observeArtifactProjectPipelines,
  type ArtifactProjectIdentity,
} from '@/stores/agentArtifactInventoryStore';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { PipelineInfo } from '@canopy/execution-engine/types/pipeline';
import {
  loadDisabledPipelineIdsBestEffort,
  setPipelineDisabled,
} from '@/lib/pipelineEnablement';
import {
  useSharedPipelineList,
  type SharedListFilters,
  type SharedCloudListState,
  type UseSharedPipelineListReturn,
} from './useSharedPipelineList';

interface UsePipelineListReturn {
  pipelines: PipelineInfo[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /**
   * `callerShowsFailure`: asked when the delete fails, whether the caller
   * shows (and records) the failure itself, so it is not also kept as the
   * list's load error. False once its confirmation is gone.
   */
  deletePipeline: (
    id: string,
    options?: { callerShowsFailure?: () => boolean },
  ) => Promise<boolean>;
  duplicatePipeline: (pipeline: PipelineInfo) => Promise<PipelineInfo | null>;

  /**
   * Pipeline ids the user has disabled. Disabled pipelines still render on the
   * management table but are hidden from every run picker.
   */
  disabledPipelineIds: Set<string>;
  /** Enable or disable a pipeline and persist the change. */
  setPipelineEnabled: (id: string, enabled: boolean) => Promise<void>;

  // Shared (Canopy Cloud) pipelines.
  shared: UseSharedPipelineListReturn;
  /**
   * Delete a shared pipeline, refresh the local list (in case the server
   * also dropped local references), and optimistically remove the row.
   */
  deleteSharedPipeline: (
    remoteId: string,
    options?: { callerShowsFailure?: () => boolean },
  ) => Promise<boolean>;
  setSharedFilters: (filters: SharedListFilters) => void;
  refreshSharedList: () => Promise<void>;
  loadMoreShared: () => Promise<void>;
}

function getErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export function usePipelineList(
  cwd?: string,
  artifactProject?: ArtifactProjectIdentity,
): UsePipelineListReturn {
  const artifactProjectId = artifactProject?.projectId;
  const artifactWorktreeId = artifactProject?.worktreeId;
  const artifactRepoId = artifactProject?.repoId;
  const [storedPipelines, setStoredPipelines] = useState<PipelineInfo[]>([]);
  const [projectPipelines, setProjectPipelines] = useState<PipelineInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [disabledPipelineIds, setDisabledPipelineIds] = useState<Set<string>>(
    () => new Set(),
  );
  const contextEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key),
  );
  const contextGeneration = useWorkspaceContextStore((state) =>
    contextEnabled ? state.appliedGeneration : 0,
  );
  const refreshIdRef = useRef(0);

  const shared = useSharedPipelineList();

  useEffect(() => {
    let cancelled = false;
    void loadDisabledPipelineIdsBestEffort().then((ids) => {
      if (!cancelled) setDisabledPipelineIds(ids);
    });
    return (): void => {
      cancelled = true;
    };
  }, []);

  const setPipelineEnabled = useCallback(
    async (id: string, enabled: boolean): Promise<void> => {
      try {
        const next = await setPipelineDisabled(id, !enabled);
        setDisabledPipelineIds(next);
        setError(null);
      } catch (err) {
        setError(
          getErrorMessage(err, 'Failed to update workflow enabled state'),
        );
      }
    },
    [],
  );

  const refresh = useCallback(async () => {
    const requestId = ++refreshIdRef.current;
    const artifactScope = artifactInventoryScope();
    observeArtifactPipelines(null);
    const projectIdentity =
      artifactProjectId && artifactWorktreeId
        ? {
            projectId: artifactProjectId,
            worktreeId: artifactWorktreeId,
            repoId: artifactRepoId,
          }
        : undefined;
    if (projectIdentity) observeArtifactProjectPipelines(null, projectIdentity);
    setLoading(true);
    setError(null);
    try {
      const [storedResult, projectResult] = await Promise.all([
        window.pipelines.list(),
        cwd
          ? window.pipelines.discoverProject(cwd)
          : Promise.resolve({
              success: true,
              data: [],
            }),
      ]);

      if (
        requestId !== refreshIdRef.current ||
        (contextEnabled &&
          useWorkspaceContextStore.getState().appliedGeneration !==
            contextGeneration)
      )
        return;

      const errors: string[] = [];

      if (storedResult.success && storedResult.data) {
        setStoredPipelines(storedResult.data);
        observeArtifactPipelines(storedResult.data, artifactScope);
      } else {
        setStoredPipelines([]);
        errors.push(storedResult.error || 'Failed to load workflows');
      }

      if (projectResult.success && projectResult.data) {
        setProjectPipelines(projectResult.data);
        if (projectIdentity && cwd)
          observeArtifactProjectPipelines(
            projectResult.data,
            projectIdentity,
            artifactScope,
          );
      } else {
        setProjectPipelines([]);
        if (cwd) {
          const projectError =
            'error' in projectResult && typeof projectResult.error === 'string'
              ? projectResult.error
              : undefined;
          errors.push(projectError || 'Failed to load project workflows');
        }
      }

      if (errors.length > 0) {
        setError(errors.join(' '));
      }
    } catch (err) {
      if (
        requestId !== refreshIdRef.current ||
        (contextEnabled &&
          useWorkspaceContextStore.getState().appliedGeneration !==
            contextGeneration)
      )
        return;
      setError(getErrorMessage(err, 'Failed to load workflows'));
    } finally {
      if (requestId === refreshIdRef.current) {
        setLoading(false);
      }
    }
  }, [
    cwd,
    contextEnabled,
    contextGeneration,
    artifactProjectId,
    artifactWorktreeId,
    artifactRepoId,
  ]);

  useEffect(() => {
    // Do not keep the previous account's managed catalog visible while refreshing.
    setStoredPipelines((rows) =>
      contextEnabled ? [] : rows.filter((row) => row.source !== 'curated'),
    );
    void refresh();
  }, [refresh, shared.cloudAccount, contextEnabled]);

  const deletePipeline = useCallback(
    async (
      id: string,
      options: { callerShowsFailure?: () => boolean } = {},
    ): Promise<boolean> => {
      try {
        const result = await window.pipelines.delete(id);
        if (result.success) {
          await refresh();
          return true;
        }
        if (!options.callerShowsFailure?.())
          setError(result.error || 'Failed to delete workflow');
      } catch (err) {
        if (!options.callerShowsFailure?.())
          setError(getErrorMessage(err, 'Failed to delete workflow'));
      }
      return false;
    },
    [refresh],
  );

  const duplicatePipeline = useCallback(
    async (pipeline: PipelineInfo): Promise<PipelineInfo | null> => {
      try {
        const result =
          pipeline.source === 'project' && cwd && pipeline.filePath
            ? await window.pipelines.duplicate({
                id: pipeline.id,
                cwd,
                filePath: pipeline.filePath,
              })
            : pipeline.source === 'curated'
              ? await window.pipelines.duplicate({
                  source: 'curated',
                  id: pipeline.id,
                })
              : pipeline.source === 'shared' && pipeline.remoteId
                ? await window.pipelines.duplicate({
                    source: 'shared',
                    remoteId: pipeline.remoteId,
                  })
                : await window.pipelines.duplicate(pipeline.id);
        if (result.success && result.data) {
          await refresh();
          return result.data;
        }
        setError(result.error || 'Failed to duplicate workflow');
      } catch (err) {
        setError(getErrorMessage(err, 'Failed to duplicate workflow'));
      }
      return null;
    },
    [cwd, refresh],
  );

  const deleteSharedPipeline = useCallback(
    async (
      remoteId: string,
      options: { callerShowsFailure?: () => boolean } = {},
    ): Promise<boolean> => {
      try {
        const result = await window.pipelines.deleteShared({ remoteId });
        if (result.success) {
          shared.removeSharedRow(remoteId);
          return true;
        }
        if (!options.callerShowsFailure?.())
          setError(result.error || 'Failed to delete shared workflow');
      } catch (err) {
        if (!options.callerShowsFailure?.())
          setError(getErrorMessage(err, 'Failed to delete shared workflow'));
      }
      return false;
    },
    [shared],
  );

  const pipelines = useMemo(
    () => [...storedPipelines, ...projectPipelines],
    [storedPipelines, projectPipelines],
  );

  return {
    pipelines,
    loading,
    error,
    refresh,
    deletePipeline,
    duplicatePipeline,
    disabledPipelineIds,
    setPipelineEnabled,

    shared,
    deleteSharedPipeline,
    setSharedFilters: shared.setFilters,
    refreshSharedList: shared.refreshShared,
    loadMoreShared: shared.loadMoreShared,
  };
}

export type { SharedCloudListState, SharedListFilters };
