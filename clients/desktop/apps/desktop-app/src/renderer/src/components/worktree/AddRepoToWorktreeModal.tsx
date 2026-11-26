import {
  reportClientAppError,
  resolveClientAppError,
} from '@canopy/desktop-instrumentation/client';
import { toAppError, type AppError } from '@canopy/protocol/app-errors';
import {
  inlineFailure,
  inlineFailureReason,
  inputFailure,
  type InlineFailure,
} from '@/lib/inline-app-error';
import { rendererAppErrorDisplayPolicy } from '@/lib/renderer-app-error';
import { extractIpcErrorMessage } from '@/lib/errors';
import { DesktopReportThisAction } from '@/components/shared/DesktopReportThisAction';
import {
  DesktopOrgSharedMultiRepoSetup,
  useSharedMultiRepoRouting,
} from './DesktopOrgSharedMultiRepoSetup';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import type {
  AdhocMultiRepoMode,
  AdhocMultiRepoCombineResponse,
  AdhocMultiRepoJoinOption,
  ExistingWorktreeJoinCandidate,
  ExistingWorktreeJoinWorkspaceGroup,
} from '@canopy/desktop-shared/types';
import {
  Stack,
  CenteredLoadingSpinner,
  ChoiceList,
  ChoiceField,
  DelayedLoadingPlaceholder,
  EmptyState,
  Notice,
  Surface,
  NoticeButton,
} from '@canopy/ui-shared/components';
import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { brandText } from '@/lib/brand';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  isWorkspaceIdInScopingContext,
  switchContextForWorkspace,
} from '@/lib/contextScope';
import { DialogModal } from '../shared';
import {
  ExistingWorktreePicker,
  getCandidateWarnings,
} from './ExistingWorktreePicker';
import { renderDesktopWorkspaceOption } from './WorkspaceMultiSelectPicker';
import {
  AddRepositoryDialog,
  type AddRepositoryPickerMode,
} from '@canopy/ui-app/code/shell/AddRepositoryDialog';

const SETUP_RUNNING_REASONS = new Set([
  'Wait for running scripts, such as setup, to finish before adding a repo to this worktree.',
  'Wait for the selected worktree’s running scripts, such as setup, to finish before joining it.',
]);
const SETUP_RUNNING_FAILURE: InlineFailure = {
  error: 'Setup is still running. Try again when it finishes.',
};

/**
 * Whether main refused because setup is still running. The reason arrives
 * inside Electron's IPC wrapper, or as the message of the error main recorded.
 */
function isSetupRunning(reason: string | undefined): boolean {
  return (
    reason !== undefined &&
    SETUP_RUNNING_REASONS.has(extractIpcErrorMessage(reason).trim())
  );
}

/** A caught combine or join failure, led by the action's own sentence. */
function combineFailure(appError: AppError, copy: string): InlineFailure {
  if (isSetupRunning(appError.detail.message)) return SETUP_RUNNING_FAILURE;
  return inlineFailure(appError, copy);
}

/** The failure the projects store recorded for a combine that returned none. */
function storedCombineFailure(
  failure: InlineFailure | null,
  copy: string,
): InlineFailure {
  if (!failure) return { error: copy };
  return isSetupRunning(inlineFailureReason(failure))
    ? SETUP_RUNNING_FAILURE
    : failure;
}

function renderReportAction(error: AppError): JSX.Element {
  return <DesktopReportThisAction error={error} appName={brandText.appName} />;
}

interface AddRepoToWorktreeModalProps {
  onOpenSharedDestination?: (workspaceId: string) => void;
  /** Workspace that owns the source worktree the user just acted on. */
  sourceWorkspaceId: string;
  /** Worktree the user wants to combine into a multi-repo destination. */
  sourceWorktreeId: string;
  onClose: () => void;
}

/**
 * Lands in the navigation context that owns a freshly joined destination, so
 * the sidebar shows its row before the worktree is selected. Resolves `false`
 * when the switch was refused or the owner cannot be resolved. The join is
 * already committed by then, so a navigation failure is contained here
 * instead of being reported as a failed join.
 */
async function showDestinationContext(
  destinationWorkspaceId: string,
): Promise<boolean> {
  try {
    return await switchContextForWorkspace(destinationWorkspaceId);
  } catch (error) {
    // The caller explains where the destination lives instead.
    reportClientAppError(error);
    return false;
  }
}

/** A committed move must either open its destination or explain where it lives. */
function finishCombinedDestination(
  response: AdhocMultiRepoCombineResponse,
  visible: boolean,
  message: string,
): void {
  const { addToast } = useGitHubStore.getState();
  const meta = {
    projectId: response.destinationWorkspaceId,
    worktreeId: response.destinationWorktreeId,
  };
  if (
    visible &&
    isWorkspaceIdInScopingContext(response.destinationWorkspaceId)
  ) {
    // Selection alone does not leave Home/New task. Reassert it only after
    // every canonical tab migration has settled, so the moved chat is ready.
    useNavigationStore.getState().navigate('main');
    useChatStore
      .getState()
      .selectWorktree(
        response.destinationWorkspaceId,
        response.destinationWorktreeId,
      );
    addToast(message, 'success', undefined, meta);
    return;
  }
  const destination =
    useProjectsStore
      .getState()
      .projects.find((item) => item.id === response.destinationWorkspaceId) ??
    response.destinationWorkspace;
  const location = destination.owner
    ? `organization ${destination.owner.organizationId}`
    : 'Personal';
  addToast(
    `Combined into "${destination.name}" (${response.destinationWorkspaceId}) in ${location}, but it could not be opened in the current context. The moved chats are there. Switch to an account with access to open the project.`,
    'warning',
    undefined,
    {
      ...meta,
      forceInApp: true,
      keepUntilDismissed: true,
      blockMessageFromReplay: true,
    },
  );
}

/**
 * Clear the selection only while it still points at a worktree this join
 * consumed, so tab migration cannot activate a row the sidebar is hiding.
 * A selection the user changed meanwhile is left alone.
 */
function clearConsumedWorktreeSelection(
  projectId: string,
  worktreeId: string,
): void {
  const { selectedWorktree, deselectWorktree } = useChatStore.getState();
  if (
    selectedWorktree?.projectId === projectId &&
    selectedWorktree.worktreeId === worktreeId
  ) {
    deselectWorktree();
  }
}

/**
 * "Add repo" modal that combines an existing worktree with another workspace
 * into an adhoc multi-repo destination worktree. Calls
 * `projectsStore.combineWorktreeWithWorkspace`, and on success threads chat
 * and file tabs onto the destination via
 * `chatStore.migrateWorktreeTabsToAdhocWorkspace`. Once the projects store has
 * registered the destination, the modal switches to the context that owns it
 * (its organization, or Personal when it is unowned) and then selects it, with
 * generic tab hydration deferred so migration can safely stage the destination
 * tabs. If that switch is refused the join still completes and its tabs still
 * migrate; the destination is just not selected, because the sidebar would be
 * hiding it. The picker is
 * loaded from the main process so workspaces that add no new repo are filtered
 * using the same repo identity rules as the combine flow.
 *
 * For non-temporary multi-repo source workspaces, the user can choose
 * whether to land in a brand-new temporary destination workspace or to
 * extend the source workspace itself (the "Update project" mode). For
 * single-repo and temporary multi-repo sources, the mode is locked to
 * temporary.
 *
 * Temporary never depends on the shared-project classification. An Update of
 * shared organization sources routes to shared setup once classified, and one
 * that is unclassified cannot be submitted. An organization source can also
 * ask for shared setup directly, keeping the current selection.
 */
export function AddRepoToWorktreeModal(
  props: AddRepoToWorktreeModalProps,
): JSX.Element {
  return (
    <AddRepoToWorktreeModalContent
      key={`${props.sourceWorkspaceId}:${props.sourceWorktreeId}`}
      {...props}
    />
  );
}

function AddRepoToWorktreeModalContent({
  onOpenSharedDestination,
  sourceWorkspaceId,
  sourceWorktreeId,
  onClose,
}: AddRepoToWorktreeModalProps): JSX.Element {
  const projects = useProjectsStore((state) => state.projects);
  const combineWorktreeWithWorkspace = useProjectsStore(
    (state) => state.combineWorktreeWithWorkspace,
  );
  const combineWorktreeWithExistingWorktree = useProjectsStore(
    (state) => state.combineWorktreeWithExistingWorktree,
  );
  const migrateWorktreeTabsToAdhocWorkspace = useChatStore(
    (state) => state.migrateWorktreeTabsToAdhocWorkspace,
  );
  const flushWorktreeTabs = useChatStore((state) => state.flushWorktreeTabs);
  const selectWorktree = useChatStore((state) => state.selectWorktree);

  const sourceWorkspace = useMemo(
    () => projects.find((p) => p.id === sourceWorkspaceId),
    [projects, sourceWorkspaceId],
  );

  const sourceIsNonTempMultiRepo =
    sourceWorkspace?.type === 'multi-repo' &&
    sourceWorkspace.temporary !== true;

  const [workspaceOptions, setWorkspaceOptions] = useState<
    AdhocMultiRepoJoinOption[]
  >([]);
  const [loadingOptions, setLoadingOptions] = useState(true);
  const [selectedWorkspaceIds, setSelectedWorkspaceIds] = useState<string[]>(
    [],
  );
  const [mode, setMode] = useState<AdhocMultiRepoMode>('temporary');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<InlineFailure | null>(null);
  // Which load failed, so Try again repeats it. Combine and join failures
  // offer no repeat: a partial combine may not be safe to run again.
  const [failedLoad, setFailedLoad] = useState<'projects' | 'worktrees' | null>(
    null,
  );
  const showFailure = useCallback(
    (
      failure: InlineFailure | null,
      load: 'projects' | 'worktrees' | null = null,
    ): void => {
      setErrorMessage(failure);
      setFailedLoad(failure ? load : null);
    },
    [],
  );
  const [pickerMode, setPickerMode] =
    useState<AddRepositoryPickerMode>('new-worktrees');
  const [existingGroups, setExistingGroups] = useState<
    ExistingWorktreeJoinWorkspaceGroup[]
  >([]);
  const [loadingExisting, setLoadingExisting] = useState(false);
  const [hasLoadedExisting, setHasLoadedExisting] = useState(false);
  const [selectedExisting, setSelectedExisting] =
    useState<ExistingWorktreeJoinCandidate | null>(null);
  const [existingSearchQuery, setExistingSearchQuery] = useState('');
  const selectedExistingGroup = useMemo(
    () =>
      selectedExisting
        ? existingGroups.find(
            (group) => group.workspaceId === selectedExisting.workspaceId,
          )
        : undefined,
    [existingGroups, selectedExisting],
  );

  const showModeToggle = sourceIsNonTempMultiRepo;
  const effectiveMode: AdhocMultiRepoMode = showModeToggle ? mode : 'temporary';
  const updatingSource = effectiveMode === 'update-source-workspace';
  const selectedIds =
    pickerMode === 'new-worktrees'
      ? selectedWorkspaceIds
      : selectedExisting
        ? [selectedExisting.workspaceId]
        : [];
  const updateRouting = useSharedMultiRepoRouting(
    updatingSource && selectedIds.length > 0
      ? [sourceWorkspaceId, ...selectedIds]
      : [],
  );
  // Only a classification that admits the update may reach the mutating path.
  const updateBlocked = updatingSource && updateRouting !== 'legacy';
  // Remembered per source, so another source starts back at the picker.
  const sharedSetupSource = `${sourceWorkspaceId}:${sourceWorktreeId}`;
  const [sharedSetupRequestedFor, setSharedSetupRequestedFor] = useState<
    string | null
  >(null);
  // A combine in flight refreshes projects; it must not swap the dialog away.
  const showSharedSetup =
    !submitting &&
    (sharedSetupRequestedFor === sharedSetupSource ||
      (updatingSource && updateRouting === 'shared'));

  useCurrentUiStateReporter('worktree.adhocJoinModal', {
    open: true,
    sourceWorkspaceId,
    sourceWorktreeId,
    pickerMode,
    mode,
    workspaceOptionCount: workspaceOptions.length,
    selectedWorkspaceCount: selectedWorkspaceIds.length,
    existingWorkspaceGroupCount: existingGroups.length,
    existingCandidateCount: existingGroups.reduce(
      (sum, group) => sum + group.candidates.length,
      0,
    ),
    ...(selectedExisting
      ? {
          selectedExisting: {
            workspaceId: selectedExisting.workspaceId,
            worktreeId: selectedExisting.worktreeId,
            ...(selectedExistingGroup
              ? { workspaceName: selectedExistingGroup.workspaceName }
              : {}),
            worktreeName: selectedExisting.branchName,
          },
        }
      : {}),
    loading: pickerMode === 'new-worktrees' ? loadingOptions : loadingExisting,
    submitting,
    errorVisible: errorMessage !== null,
    sharedSetupVisible: showSharedSetup,
  });

  // Track the modal's mounted lifetime and the latest in-flight existing-load
  // request so a superseded or post-unmount response is ignored. Loads run
  // imperatively (mount, first switch, manual refresh) rather than as an
  // effect so switching pills never re-fetches.
  const mountedRef = useRef(true);
  const existingRequestIdRef = useRef(0);
  useEffect(() => {
    return (): void => {
      mountedRef.current = false;
    };
  }, []);

  const loadWorkspaceOptions = useCallback(async (): Promise<void> => {
    setLoadingOptions(true);
    showFailure(null);
    setSelectedWorkspaceIds([]);
    try {
      const response = await window.api.listAdhocMultiRepoJoinOptions({
        sourceWorkspaceId,
      });
      if (!mountedRef.current) return;
      setWorkspaceOptions(response.options);
    } catch (cause: unknown) {
      if (!mountedRef.current) return;
      setWorkspaceOptions([]);
      const appError = toAppError(resolveClientAppError(cause));
      if (appError) {
        showFailure(
          inlineFailure(appError, "Couldn't load projects."),
          'projects',
        );
      }
    } finally {
      if (mountedRef.current) {
        setLoadingOptions(false);
      }
    }
  }, [showFailure, sourceWorkspaceId]);

  useEffect(() => {
    void loadWorkspaceOptions();
  }, [loadWorkspaceOptions]);

  const loadExistingOptions = useCallback(async (): Promise<void> => {
    const requestId = ++existingRequestIdRef.current;
    setLoadingExisting(true);
    showFailure(null);
    setSelectedExisting(null);
    try {
      const response = await window.api.listExistingWorktreeJoinOptions({
        sourceWorkspaceId,
        sourceWorktreeId,
      });
      if (!mountedRef.current || existingRequestIdRef.current !== requestId) {
        return;
      }
      setExistingGroups(response.groups);
    } catch (cause: unknown) {
      if (!mountedRef.current || existingRequestIdRef.current !== requestId) {
        return;
      }
      setExistingGroups([]);
      const appError = toAppError(resolveClientAppError(cause));
      if (appError) {
        showFailure(
          inlineFailure(appError, "Couldn't load worktrees."),
          'worktrees',
        );
      }
    } finally {
      if (mountedRef.current && existingRequestIdRef.current === requestId) {
        setLoadingExisting(false);
        setHasLoadedExisting(true);
      }
    }
  }, [showFailure, sourceWorkspaceId, sourceWorktreeId]);

  // Lazily load the existing-worktree picker the first time it is shown, then
  // keep the result for the modal's lifetime. Switching pills never refetches;
  // the Refresh button is the only way to repopulate.
  const showExistingPicker = useCallback((): void => {
    setPickerMode('existing-worktrees');
    showFailure(null);
    if (!hasLoadedExisting && !loadingExisting) {
      void loadExistingOptions();
    }
  }, [hasLoadedExisting, loadingExisting, loadExistingOptions, showFailure]);

  const selectedExistingWarnings = useMemo<string[]>(
    () => (selectedExisting ? getCandidateWarnings(selectedExisting) : []),
    [selectedExisting],
  );

  const handleCombine = useCallback(async (): Promise<void> => {
    if (submitting || updateBlocked) return;
    if (selectedWorkspaceIds.length === 0) {
      showFailure(inputFailure('Choose at least one project to combine with.'));
      return;
    }
    showFailure(null);
    setSubmitting(true);
    try {
      // Flush any pending chat-tab persistence on the source so the migration
      // sees the latest state. Mirrors the chatStore migration contract.
      await flushWorktreeTabs(sourceWorkspaceId, sourceWorktreeId);

      const response = await combineWorktreeWithWorkspace({
        sourceWorkspaceId,
        sourceWorktreeId,
        joinWorkspaceIds: selectedWorkspaceIds,
        mode: effectiveMode,
      });

      if (!response) {
        // projectsStore set `worktreeError`; read it directly so we keep the
        // modal-local error area in sync with whatever the backend reported.
        showFailure(
          storedCombineFailure(
            useProjectsStore.getState().worktreeError,
            "Couldn't combine projects.",
          ),
        );
        return;
      }

      // `combineWorktreeWithWorkspace` has already refreshed projects, so the
      // destination row and its persisted owner are now known. Land in its
      // context, then activate it before potentially slow tab migration; defer
      // generic hydration so it cannot race and overwrite the migrated
      // destination state.
      const destinationVisible = await showDestinationContext(
        response.destinationWorkspaceId,
      );
      if (destinationVisible) {
        selectWorktree(
          response.destinationWorkspaceId,
          response.destinationWorktreeId,
          { deferTabLoad: true },
        );
      }

      if (response.removedSourceWorktree) {
        if (!destinationVisible) {
          clearConsumedWorktreeSelection(
            response.sourceWorkspaceId,
            response.sourceWorktreeId,
          );
        }
        await migrateWorktreeTabsToAdhocWorkspace(response);
      }

      finishCombinedDestination(
        response,
        destinationVisible,
        effectiveMode === 'update-source-workspace'
          ? 'Project updated'
          : 'Created multi-repo worktree',
      );
      onClose();
    } catch (cause: unknown) {
      const appError = toAppError(resolveClientAppError(cause));
      if (appError)
        showFailure(combineFailure(appError, "Couldn't combine projects."));
    } finally {
      setSubmitting(false);
    }
  }, [
    combineWorktreeWithWorkspace,
    effectiveMode,
    flushWorktreeTabs,
    migrateWorktreeTabsToAdhocWorkspace,
    onClose,
    selectWorktree,
    selectedWorkspaceIds,
    showFailure,
    sourceWorkspaceId,
    sourceWorktreeId,
    submitting,
    updateBlocked,
  ]);

  const handleJoinExisting = useCallback(async (): Promise<void> => {
    if (submitting || updateBlocked || !selectedExisting) return;
    showFailure(null);
    setSubmitting(true);
    try {
      // Flush pending chat-tab persistence on both consumed worktrees so the
      // migrations below see the latest state.
      await flushWorktreeTabs(sourceWorkspaceId, sourceWorktreeId);
      await flushWorktreeTabs(
        selectedExisting.workspaceId,
        selectedExisting.worktreeId,
      );

      const response = await combineWorktreeWithExistingWorktree({
        sourceWorkspaceId,
        sourceWorktreeId,
        joinWorkspaceId: selectedExisting.workspaceId,
        joinWorktreeId: selectedExisting.worktreeId,
        mode: effectiveMode,
      });
      if (!response) {
        showFailure(
          storedCombineFailure(
            useProjectsStore.getState().worktreeError,
            "Couldn't join the worktree.",
          ),
        );
        return;
      }

      // Land in the destination's context, then make the resulting worktree
      // active as soon as it is visible there. The two source migrations can
      // hydrate and fork tabs afterward without delaying the visible selection.
      const destinationVisible = await showDestinationContext(
        response.destinationWorkspaceId,
      );
      if (destinationVisible) {
        selectWorktree(
          response.destinationWorkspaceId,
          response.destinationWorktreeId,
          { deferTabLoad: true },
        );
      }

      if (response.removedSourceWorktree) {
        if (!destinationVisible) {
          clearConsumedWorktreeSelection(
            response.sourceWorkspaceId,
            response.sourceWorktreeId,
          );
        }
        await migrateWorktreeTabsToAdhocWorkspace(response);
      }
      // The joined worktree is always consumed: run the same migration with
      // the joined side substituted in as the "source" of the move.
      const joined = response.joinedWorktree;
      if (!destinationVisible) {
        clearConsumedWorktreeSelection(joined.workspaceId, joined.worktreeId);
      }
      await migrateWorktreeTabsToAdhocWorkspace({
        ...response,
        sourceWorkspaceId: joined.workspaceId,
        sourceWorktreeId: joined.worktreeId,
        repoMappings: joined.repoMappings,
        selectedRepoIdRewrites: joined.selectedRepoIdRewrites,
        sourceRootRepoIdRewrite: joined.sourceRootRepoIdRewrite,
        filePathRewrites: joined.filePathRewrites,
        compatibilitySymlinks: joined.compatibilitySymlinks,
        removedTemporaryWorkspaceId: joined.removedTemporaryWorkspaceId,
      });
      finishCombinedDestination(
        response,
        destinationVisible,
        effectiveMode === 'update-source-workspace'
          ? 'Project updated'
          : 'Joined worktree',
      );
      onClose();
    } catch (cause: unknown) {
      const appError = toAppError(resolveClientAppError(cause));
      if (appError)
        showFailure(combineFailure(appError, "Couldn't join the worktree."));
    } finally {
      setSubmitting(false);
    }
  }, [
    combineWorktreeWithExistingWorktree,
    effectiveMode,
    flushWorktreeTabs,
    migrateWorktreeTabsToAdhocWorkspace,
    onClose,
    selectWorktree,
    selectedExisting,
    showFailure,
    sourceWorkspaceId,
    sourceWorktreeId,
    submitting,
    updateBlocked,
  ]);

  const selectedSharedSources = [
    sourceWorkspace,
    ...selectedIds.map((id) => projects.find((project) => project.id === id)),
  ].filter((project) => project !== undefined);
  if (showSharedSetup) {
    return (
      <DialogModal
        onClose={onClose}
        title="New shared multi-repo project"
        titleId="shared-multi-repo-title"
        maxWidth="xl"
        maxHeight="calc(100dvh - 2rem)"
        scrollableBody={false}
      >
        <DesktopOrgSharedMultiRepoSetup
          mode="combine"
          onClose={onClose}
          sources={selectedSharedSources.map((project) => ({
            kind: 'workspace',
            id: project.id,
            name: project.name,
          }))}
          onOpenDestination={onOpenSharedDestination}
        />
      </DialogModal>
    );
  }

  return (
    <AddRepositoryDialog
      onClose={onClose}
      pickerMode={pickerMode}
      onPickerModeChange={(nextMode) => {
        if (nextMode === 'existing-worktrees') {
          showExistingPicker();
          return;
        }
        setPickerMode('new-worktrees');
        showFailure(null);
      }}
      newWorktreesDescription={
        <>
          Choose one or more projects to combine with this worktree.{' '}
          {brandText.appName} will create a multi-repo worktree and keep the
          original path available with a compatibility symlink.
        </>
      }
      workspaceOptions={workspaceOptions}
      loadingOptions={loadingOptions}
      onRefreshOptions={() => void loadWorkspaceOptions()}
      selectedWorkspaceIds={selectedWorkspaceIds}
      onSelectedWorkspaceIdsChange={setSelectedWorkspaceIds}
      renderOptionIcon={renderDesktopWorkspaceOption}
      onCombine={() => void handleCombine()}
      existingWorktrees={{
        loading: loadingExisting,
        canSubmit: selectedExisting !== null,
        onSubmit: () => void handleJoinExisting(),
        onRefresh: () => void loadExistingOptions(),
        content: (
          <>
            <p className="text-xs fg-secondary">
              Choose a worktree to join into this one. Its changes move into a
              combined worktree and the original paths stay valid via
              compatibility symlinks.
            </p>

            {loadingExisting || !hasLoadedExisting ? (
              <DelayedLoadingPlaceholder slowNote="Still loading worktrees…">
                <CenteredLoadingSpinner />
              </DelayedLoadingPlaceholder>
            ) : existingGroups.length === 0 ? (
              <EmptyState
                testId="add-repo-to-worktree-modal-existing-empty"
                title="No worktrees to join"
                subtitle="Create a worktree in another project first, then join it into this one."
              />
            ) : (
              <ExistingWorktreePicker
                groups={existingGroups}
                selected={
                  selectedExisting
                    ? {
                        workspaceId: selectedExisting.workspaceId,
                        worktreeId: selectedExisting.worktreeId,
                      }
                    : null
                }
                onSelect={setSelectedExisting}
                searchQuery={existingSearchQuery}
                onSearchQueryChange={setExistingSearchQuery}
              />
            )}

            {selectedExisting && selectedExistingWarnings.length > 0 && (
              <Notice
                role="none"
                intent="attention"
                data-testid="add-repo-to-worktree-modal-overlap-warnings"
              >
                <Stack gap="tight">
                  {selectedExistingWarnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                </Stack>
              </Notice>
            )}
          </>
        ),
      }}
      selectionAccessory={
        showModeToggle ? (
          <Surface variant="group" gap="inline" padding="compact">
            <span className="block text-xs fg-secondary">Update mode</span>
            <ChoiceList className="" kind="radio" aria-label="Update mode">
              <ChoiceField
                layout="row"
                kind="radio"
                checked={mode === 'temporary'}
                onChange={() => setMode('temporary')}
                disabled={submitting}
                data-testid="add-repo-to-worktree-modal-mode-temporary"
                label={
                  <Stack gap="tight">
                    <span className="block text-s font-medium">Temporary</span>
                    <span className="block text-xs fg-secondary">
                      Create or reuse a temporary multi-repo project for this
                      worktree only.
                    </span>
                  </Stack>
                }
              />
              <ChoiceField
                layout="row"
                kind="radio"
                checked={mode === 'update-source-workspace'}
                onChange={() => setMode('update-source-workspace')}
                disabled={submitting}
                data-testid="add-repo-to-worktree-modal-mode-update"
                label={
                  <Stack gap="tight">
                    <span className="block text-s font-medium">
                      Update project
                    </span>
                    <span className="block text-xs fg-secondary">
                      Add missing repos to this project and this worktree.
                    </span>
                  </Stack>
                }
              />
            </ChoiceList>
          </Surface>
        ) : null
      }
      notices={
        <>
          {updateBlocked && selectedIds.length > 0 ? (
            <Notice
              intent={updateRouting === 'unavailable' ? 'attention' : 'neutral'}
              data-testid="add-repo-to-worktree-modal-update-check"
            >
              {updateRouting === 'unavailable'
                ? 'Couldn’t check whether this project can be updated. Use Temporary, or refresh and try again.'
                : 'Checking whether this project can be updated…'}
            </Notice>
          ) : null}
          {sourceWorkspace?.owner?.type === 'organization' ? (
            <Notice
              intent="neutral"
              role="none"
              actions={
                <NoticeButton
                  disabled={submitting}
                  onClick={() => setSharedSetupRequestedFor(sharedSetupSource)}
                  data-testid="add-repo-to-worktree-modal-create-shared"
                >
                  Create shared project instead
                </NoticeButton>
              }
            >
              To make these repositories a project your whole organization can
              use, create a shared project.
            </Notice>
          ) : null}
        </>
      }
      submitBlocked={updateBlocked}
      submitting={submitting}
      errorMessage={errorMessage?.error ?? null}
      {...(errorMessage?.details === undefined
        ? {}
        : { errorDetails: errorMessage.details })}
      {...(failedLoad === 'projects'
        ? { onErrorRetry: () => void loadWorkspaceOptions() }
        : failedLoad === 'worktrees'
          ? { onErrorRetry: () => void loadExistingOptions() }
          : {})}
      errorDisplayPolicy={rendererAppErrorDisplayPolicy}
      renderErrorReportAction={renderReportAction}
    />
  );
}
