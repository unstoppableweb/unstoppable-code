import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { useShallow } from 'zustand/shallow';
import type {
  DetectedPlanEntry,
  TrackedPlanData,
} from '@canopy/desktop-shared/types';
import { isImportablePlanFile } from '@canopy/desktop-shared/importable-plan-file';
import { useCanopyClient } from '@canopy/app-state';
import {
  ImportPlanPicker,
  type ImportPlanFileRow,
  type ImportPlanPickerGroup,
  type ImportPlanPickerItem,
  type ImportPlanSuggestion,
} from '@canopy/ui-app/plans';
import {
  getWorktreeCacheKey,
  useFileListStore,
  useRetainFileIndex,
} from '@/stores/fileListStore';
import { useActivityStore } from '@/stores/activityStore';
import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { searchFiles } from '@/lib/fuzzySearch';
import { openTrackedPlan } from '@/lib/plans/open-tracked-plan';
import { importDetectedPlan } from '@/lib/plans/import-detected-plan';
import {
  createTrackedPlanSourceLookup,
  toSourceFileRootId,
} from '@/lib/plans/tracked-plan-sources';
import { getFilenameMatchedIndices } from '@/components/file-search-palette/file-search-palette-helpers';
import { shouldFetchFileSearchPaletteEntry } from '@/components/file-search-palette/file-search-palette-state';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';

const RESULT_LIMIT = 50;

// Stable empty references so the Zustand selectors do not return a fresh
// array each render (which loops useSyncExternalStore — "Maximum update
// depth exceeded") when the worktree has no detections or plans.
const EMPTY_DETECTED_PLANS: DetectedPlanEntry[] = [];
const EMPTY_TRACKED_PLANS: TrackedPlanData[] = [];

interface ImportPlanModalProps {
  projectId: string;
  worktreeId: string;
  onClose: () => void;
  onImported: (plan: TrackedPlanData) => void;
  /** Open an already-tracked plan instead of importing it again. */
  onOpenTracked?: (planId: string) => void;
  originChatId?: string;
}

export function ImportPlanModal({
  projectId,
  worktreeId,
  onClose,
  onImported,
  onOpenTracked,
  originChatId,
}: ImportPlanModalProps): JSX.Element {
  const client = useCanopyClient();
  const [query, setQuery] = useState('');
  const [importing, setImporting] = useState(false);
  const [selectedGroup, setSelectedGroup] =
    useState<ImportPlanPickerGroup | null>(null);
  const importingRef = useRef(false);
  const deferredQuery = useDeferredValue(query);

  const importTrackedPlan = useActivityStore(
    (state) => state.importTrackedPlan,
  );
  const loadDetectedPlans = useActivityStore(
    (state) => state.loadDetectedPlans,
  );
  const loadTrackedPlans = useActivityStore((state) => state.loadTrackedPlans);
  const updateDetectedPlan = useActivityStore(
    (state) => state.updateDetectedPlan,
  );
  const addToast = useGitHubStore((state) => state.addToast);

  const worktreeKey = `${projectId}/${worktreeId}`;
  const detectedEntries = useActivityStore(
    (state) => state.detectedPlans[worktreeKey] ?? EMPTY_DETECTED_PLANS,
  );
  const trackedPlans = useActivityStore(
    (state) => state.trackedPlans[worktreeKey] ?? EMPTY_TRACKED_PLANS,
  );
  const trackedPlansLoaded = useActivityStore(
    (state) => state.trackedPlanInventoryLoaded[worktreeKey] === true,
  );
  const chatTabs = useChatStore((state) => state.worktreeChats[worktreeKey]);

  const cacheKey = getWorktreeCacheKey(projectId, worktreeId);
  useRetainFileIndex(cacheKey);
  const { entry, error, isLoading, fetchFileIndex } = useFileListStore(
    useShallow((state) => ({
      entry: state.indexCache[cacheKey],
      error: state.indexErrors[cacheKey],
      isLoading: state.indexLoading.has(cacheKey),
      fetchFileIndex: state.fetchFileIndex,
    })),
  );

  useEffect(() => {
    if (!shouldFetchFileSearchPaletteEntry(entry, isLoading, error)) return;
    void fetchFileIndex(projectId, worktreeId);
  }, [entry, error, fetchFileIndex, isLoading, projectId, worktreeId]);

  useEffect(() => {
    void loadDetectedPlans(projectId, worktreeId);
  }, [loadDetectedPlans, projectId, worktreeId]);

  // The duplicate guard needs every tracked plan, which only loads once the
  // Plans section has shown this worktree.
  useEffect(() => {
    if (trackedPlansLoaded) return;
    void loadTrackedPlans(projectId, worktreeId).catch((): void => undefined);
  }, [loadTrackedPlans, projectId, trackedPlansLoaded, worktreeId]);

  // The file root that is the worktree itself: `WORKSPACE_ROOT_REPO_ID` in a
  // multi-repo worktree, the workspace id in a single-repo one. Main stores
  // imports and detections of either as the workspace root.
  const worktreeRootFileRootId = useMemo(() => {
    const repos = entry?.data.repos ?? [];
    return (
      repos.find((repo) => repo.rootKind === 'workspace-root') ??
      repos.find((repo) => repo.repoId === projectId)
    )?.repoId;
  }, [entry, projectId]);

  const trackedPlanIdFor = useMemo(
    () =>
      createTrackedPlanSourceLookup(
        trackedPlans,
        detectedEntries,
        worktreeRootFileRootId,
      ),
    [detectedEntries, trackedPlans, worktreeRootFileRootId],
  );

  // Searching the whole index is the expensive part, so it does not rerun
  // when only the tracked plans or detections change.
  const searchResults = useMemo(() => {
    const repos = (entry?.data.repos ?? [])
      .filter(
        (repo) =>
          repo.rootKind === 'git-repo' || repo.rootKind === 'workspace-root',
      )
      .map((repo) => ({
        ...repo,
        files: repo.files.filter((file) => isImportablePlanFile(file.filename)),
      }));
    return searchFiles(deferredQuery, repos, RESULT_LIMIT);
  }, [deferredQuery, entry]);

  const files = useMemo<ImportPlanFileRow[]>(
    () =>
      searchResults.map((result) => {
        const trackedPlanId = trackedPlanIdFor(
          result.repoId,
          result.relativePath,
        );
        return {
          key: `${result.repoId}:${result.absolutePath}`,
          filename: result.filename,
          relativePath: result.relativePath,
          repoId: result.repoId,
          repoName: result.repoName,
          filenameMatchedIndices: getFilenameMatchedIndices(result),
          pathMatchedIndices: result.matchedIndices,
          ...(trackedPlanId ? { trackedPlanId } : {}),
        };
      }),
    [searchResults, trackedPlanIdFor],
  );

  const { suggestions, hiddenSuggestions } = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    const toSuggestion = (e: DetectedPlanEntry): ImportPlanSuggestion => {
      const chatTitle = chatTabs?.tabs.find(
        (tab) => tab.id === e.detectedInChatId,
      )?.title;
      const trackedPlanId = trackedPlanIdFor(e.sourceRepoId, e.sourceFilePath);
      return {
        id: e.id,
        sourceRepoId: e.sourceRepoId,
        sourceFilePath: e.sourceFilePath,
        ...(chatTitle ? { chatTitle } : {}),
        ...(trackedPlanId ? { trackedPlanId } : {}),
      };
    };
    const pending = detectedEntries
      .filter(
        (e) =>
          e.status === 'detected' &&
          (needle.length === 0 ||
            e.sourceFilePath.toLowerCase().includes(needle)),
      )
      .map((e, index) => ({ e, index }))
      // The chat that opened the picker lists its own files first.
      .sort((a, b) => {
        const aOrigin = a.e.detectedInChatId === originChatId ? 0 : 1;
        const bOrigin = b.e.detectedInChatId === originChatId ? 0 : 1;
        return aOrigin - bOrigin || a.index - b.index;
      })
      .map(({ e }) => toSuggestion(e));
    return {
      suggestions: pending,
      hiddenSuggestions: detectedEntries
        .filter((e) => e.status === 'dismissed')
        .map(toSuggestion),
    };
  }, [
    chatTabs,
    deferredQuery,
    detectedEntries,
    originChatId,
    trackedPlanIdFor,
  ]);

  const reportImportError = useCallback(
    (err: unknown): void => {
      addToast(
        err instanceof Error ? err.message : 'Failed to import plan',
        'error',
        undefined,
        { projectId, worktreeId, caught: err },
      );
    },
    [addToast, projectId, worktreeId],
  );

  const runExclusive = useCallback(
    async (task: () => Promise<void>): Promise<void> => {
      if (importingRef.current) return;
      importingRef.current = true;
      setImporting(true);
      try {
        await task();
      } catch (err: unknown) {
        reportImportError(err);
      } finally {
        importingRef.current = false;
        setImporting(false);
      }
    },
    [reportImportError],
  );

  const handleOpenTracked = useCallback(
    (planId: string): void => {
      if (onOpenTracked) {
        onOpenTracked(planId);
        return;
      }
      const plan = useActivityStore
        .getState()
        .trackedPlans[
          worktreeKey
        ]?.find((candidate) => candidate.id === planId);
      if (plan) onImported(plan);
    },
    [onImported, onOpenTracked, worktreeKey],
  );

  // Rows offer import until the tracked inventory loads, so recheck it before
  // importing: a file that already is a plan opens that plan instead.
  const findTrackedPlanId = useCallback(
    async (repoId: string, filePath: string): Promise<string | undefined> => {
      if (
        !useActivityStore.getState().trackedPlanInventoryLoaded[worktreeKey]
      ) {
        await loadTrackedPlans(projectId, worktreeId).catch(
          (): void => undefined,
        );
      }
      const latest = useActivityStore.getState();
      return createTrackedPlanSourceLookup(
        latest.trackedPlans[worktreeKey] ?? EMPTY_TRACKED_PLANS,
        latest.detectedPlans[worktreeKey] ?? EMPTY_DETECTED_PLANS,
        worktreeRootFileRootId,
      )(repoId, filePath);
    },
    [
      loadTrackedPlans,
      projectId,
      worktreeId,
      worktreeKey,
      worktreeRootFileRootId,
    ],
  );

  const runImport = useCallback(
    (filePath: string | undefined, repoId?: string): Promise<void> =>
      runExclusive(async () => {
        if (filePath && repoId) {
          const trackedPlanId = await findTrackedPlanId(repoId, filePath);
          if (trackedPlanId) {
            handleOpenTracked(trackedPlanId);
            return;
          }
        }
        const plan = await importTrackedPlan(
          projectId,
          worktreeId,
          filePath,
          repoId,
        );
        if (plan) {
          onImported(plan);
          onClose();
        }
        // A null result from Browse means the native dialog was cancelled;
        // keep the modal open so the user can pick again.
      }),
    [
      findTrackedPlanId,
      handleOpenTracked,
      importTrackedPlan,
      onClose,
      onImported,
      projectId,
      runExclusive,
      worktreeId,
    ],
  );

  const runImportSuggestion = useCallback(
    (suggestion: ImportPlanSuggestion): Promise<void> =>
      runExclusive(async () => {
        const detected = detectedEntries.find((e) => e.id === suggestion.id);
        if (!detected) return;
        const trackedPlanId = await findTrackedPlanId(
          detected.sourceRepoId,
          detected.sourceFilePath,
        );
        if (trackedPlanId) {
          handleOpenTracked(trackedPlanId);
          return;
        }
        // Only the chat that found the file hears about its import; the
        // picker also lists other chats' suggestions.
        const plan = await importDetectedPlan({
          projectId,
          worktreeId,
          entry: detected,
          ...(originChatId && detected.detectedInChatId === originChatId
            ? { originChatId }
            : {}),
        });
        if (plan) onImported(plan);
      }),
    [
      detectedEntries,
      findTrackedPlanId,
      handleOpenTracked,
      onImported,
      originChatId,
      projectId,
      runExclusive,
      worktreeId,
    ],
  );

  const handleImport = useCallback(
    (item: ImportPlanPickerItem): void => {
      if (item.kind === 'suggestion') {
        void runImportSuggestion(item.suggestion);
        return;
      }
      void runImport(item.file.relativePath, item.file.repoId);
    },
    [runImport, runImportSuggestion],
  );

  const handleDismiss = useCallback(
    (suggestion: ImportPlanSuggestion): void => {
      void updateDetectedPlan(projectId, worktreeId, suggestion.id, {
        status: 'dismissed',
      }).catch((err: unknown) => {
        addToast(
          err instanceof Error ? err.message : 'Failed to hide plan',
          'error',
          undefined,
          { projectId, worktreeId, caught: err },
        );
      });
    },
    [addToast, projectId, updateDetectedPlan, worktreeId],
  );

  const loadPreview = useCallback(
    async (item: ImportPlanPickerItem): Promise<string | null> => {
      const target =
        item.kind === 'suggestion'
          ? {
              repoId: toSourceFileRootId(
                item.suggestion.sourceRepoId,
                worktreeRootFileRootId,
              ),
              relativePath: item.suggestion.sourceFilePath,
            }
          : { repoId: item.file.repoId, relativePath: item.file.relativePath };
      // `file.read` is size-bounded by main, so a large file reads truncated.
      const preview = await client.query('file.read', {
        projectId,
        worktreeId,
        ...target,
      });
      return preview.content;
    },
    [client, projectId, worktreeId, worktreeRootFileRootId],
  );

  useCurrentUiStateReporter('plans.importModal', {
    open: true,
    projectId,
    worktreeId,
    ...(selectedGroup ? { selectedGroup } : {}),
    importing,
    detectedEntryCount: detectedEntries.length,
    activeDetectedEntryCount: detectedEntries.filter(
      (e) => e.status === 'detected',
    ).length,
    dismissedEntryCount: hiddenSuggestions.length,
    ...(originChatId ? { originChatId } : {}),
  });

  return (
    <ImportPlanPicker
      suggestions={suggestions}
      hiddenSuggestions={hiddenSuggestions}
      files={files}
      query={query}
      onQueryChange={setQuery}
      loading={isLoading && !entry}
      error={error ?? null}
      importing={importing}
      onImport={handleImport}
      onOpenTracked={handleOpenTracked}
      onDismissSuggestion={handleDismiss}
      onBrowse={(): void => void runImport(undefined)}
      onClose={onClose}
      loadPreview={loadPreview}
      onSelectedGroupChange={setSelectedGroup}
    />
  );
}

export function ImportPlanModalHost(): JSX.Element {
  const importModalRequest = useActivityStore(
    (state) => state.importModalRequest,
  );
  const closeImportModal = useActivityStore((state) => state.closeImportModal);

  if (!importModalRequest) {
    return <></>;
  }
  const { projectId, worktreeId, originChatId } = importModalRequest;

  // Import runs from the plan's worktree (its plan list or a chat's detection
  // notice), so the plan opens there, beside the chat that asked for it when
  // there is one. An already-tracked file opens its existing plan the same way.
  const openPlan = (planId: string): void => {
    void openTrackedPlan(
      { projectId, worktreeId, planId },
      originChatId
        ? { navigate: false, origin: { chatTabId: originChatId } }
        : { navigate: false },
    );
    closeImportModal();
  };

  // The picker is a DialogModal, which portals itself.
  return (
    <ImportPlanModal
      projectId={projectId}
      worktreeId={worktreeId}
      originChatId={originChatId}
      onClose={closeImportModal}
      onImported={(plan): void => openPlan(plan.id)}
      onOpenTracked={openPlan}
    />
  );
}
