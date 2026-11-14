'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import type {
  AppError,
  AppErrorDisplayPolicy,
} from '@canopy/protocol/app-errors';
import {
  Button,
  DialogModal,
  EmptyState,
  ErrorBanner,
  Notice,
  SegmentedControl,
  type NoticeIntent,
  type SegmentedControlOption,
} from '@canopy/ui-shared/components';
import { RefreshSpinnerIcon } from '@canopy/ui-shared/icons';
import { Tooltip } from '@canopy/ui-shared';
import {
  WorkspaceMultiSelectPicker,
  type WorkspacePickerOption,
} from './WorkspaceMultiSelectPicker';

/**
 * Which join flow the dialog shows: combine with other projects by creating
 * new worktrees for their repos, or consume an existing worktree from another
 * project. A host offers Existing worktrees only by passing its slot.
 */
export type AddRepositoryPickerMode = 'new-worktrees' | 'existing-worktrees';

/** The host's Existing worktrees mode: its own picker and submit. */
export interface AddRepositoryExistingWorktrees {
  readonly loading: boolean;
  /** The picker, its loading card or its empty state. */
  readonly content: ReactNode;
  readonly canSubmit: boolean;
  readonly onSubmit: () => void;
  readonly onRefresh: () => void;
}

/**
 * A combine the host saved earlier, still undecided or settling. While it is
 * shown, the picker and Combine give way to its status and its own actions.
 */
export interface AddRepositorySavedAttempt {
  readonly intent: NoticeIntent;
  readonly title: string;
  readonly message: string;
  /** Continue the same attempt; absent when only time or a cancel helps. */
  readonly onResume?: () => void;
  /** The attempt is moving: Resume shows it is working. */
  readonly resuming: boolean;
  /** Cancel the attempt and keep the worktree where it was. */
  readonly onCancel?: () => void;
  readonly cancelling: boolean;
}

export interface AddRepositoryDialogProps<
  TOption extends WorkspacePickerOption,
> {
  readonly onClose: () => void;
  readonly pickerMode: AddRepositoryPickerMode;
  readonly onPickerModeChange: (mode: AddRepositoryPickerMode) => void;
  /** What Combine does on this host, under the mode pills. */
  readonly newWorktreesDescription: ReactNode;
  readonly workspaceOptions: readonly TOption[];
  readonly loadingOptions: boolean;
  /** Reloads the options (and clears the selection). */
  readonly onRefreshOptions: () => void;
  readonly selectedWorkspaceIds: readonly string[];
  readonly onSelectedWorkspaceIdsChange: (ids: string[]) => void;
  readonly renderOptionIcon?: (option: TOption) => ReactNode;
  readonly onCombine: () => void;
  /** Absent: the host offers New worktrees only, and no mode pills show. */
  readonly existingWorktrees?: AddRepositoryExistingWorktrees;
  /** Shown under the picker once something is selected (e.g. Update mode). */
  readonly selectionAccessory?: ReactNode;
  /** Host notices above the actions, e.g. what Combine pauses. */
  readonly notices?: ReactNode;
  /** The host cannot accept a submit yet; its notices say why. */
  readonly submitBlocked?: boolean;
  readonly savedAttempt?: AddRepositorySavedAttempt;
  readonly submitting: boolean;
  /**
   * The dialog's failure, above its actions: an authored sentence, or a
   * structured error that shows its catalog copy and recovery.
   */
  readonly errorMessage: string | AppError | null;
  /** The raw reason behind `Copy details`, never rendered. */
  readonly errorDetails?: string;
  /** Repeats the failed step, only when doing so can fix it. */
  readonly onErrorRetry?: () => void;
  /** The host's raw-detail policy for a structured error. */
  readonly errorDisplayPolicy?: AppErrorDisplayPolicy;
  /** The host's `Report this`, rendered only beside a defect. */
  readonly renderErrorReportAction?: (error: AppError) => ReactNode;
  /** The dismiss button's label; `Cancel` by default. */
  readonly dismissLabel?: string;
  /**
   * Dismissing stays possible while submitting: a host whose combine is
   * saved server-side keeps it going after the dialog closes.
   */
  readonly dismissWhileSubmitting?: boolean;
}

const PICKER_MODE_OPTIONS: readonly SegmentedControlOption<AddRepositoryPickerMode>[] =
  [
    {
      value: 'new-worktrees',
      label: 'New worktrees',
      dataTestId: 'add-repo-to-worktree-modal-pill-new',
    },
    {
      value: 'existing-worktrees',
      label: 'Existing worktrees',
      dataTestId: 'add-repo-to-worktree-modal-pill-existing',
    },
  ];

/**
 * The Add project dialog of a worktree's Add repository action: the mode
 * pills, the project picker with its loading and empty states, the actions
 * and the error. Hosts own the candidate reads, the combine itself and the
 * navigation afterwards; they gate modes by the slots they pass.
 */
export function AddRepositoryDialog<TOption extends WorkspacePickerOption>({
  onClose,
  pickerMode,
  onPickerModeChange,
  newWorktreesDescription,
  workspaceOptions,
  loadingOptions,
  onRefreshOptions,
  selectedWorkspaceIds,
  onSelectedWorkspaceIdsChange,
  renderOptionIcon,
  onCombine,
  existingWorktrees,
  selectionAccessory,
  notices,
  submitBlocked = false,
  savedAttempt,
  submitting,
  errorMessage,
  errorDetails,
  onErrorRetry,
  errorDisplayPolicy,
  renderErrorReportAction,
  dismissLabel = 'Cancel',
  dismissWhileSubmitting = false,
}: AddRepositoryDialogProps<TOption>): JSX.Element {
  const [searchQuery, setSearchQuery] = useState('');
  const resumeRef = useRef<HTMLButtonElement | null>(null);
  const cancelAttemptRef = useRef<HTMLButtonElement | null>(null);
  const dismissRef = useRef<HTMLButtonElement | null>(null);
  const attemptNoticeRef = useRef<HTMLDivElement | null>(null);
  // The picker gives way to a saved attempt: focus moves to its first enabled
  // action (or the notice itself) instead of staying on a control that is gone.
  const showsAttempt = savedAttempt !== undefined;
  useEffect(() => {
    if (!showsAttempt) return;
    const action = [
      resumeRef.current,
      cancelAttemptRef.current,
      dismissRef.current,
    ].find((button) => button !== null && !button.disabled);
    (action ?? attemptNoticeRef.current)?.focus();
  }, [showsAttempt]);
  const existingMode =
    pickerMode === 'existing-worktrees' && existingWorktrees !== undefined;

  const handleToggleWorkspace = useCallback(
    (workspaceId: string): void => {
      onSelectedWorkspaceIdsChange(
        selectedWorkspaceIds.includes(workspaceId)
          ? selectedWorkspaceIds.filter((id) => id !== workspaceId)
          : [...selectedWorkspaceIds, workspaceId],
      );
    },
    [onSelectedWorkspaceIdsChange, selectedWorkspaceIds],
  );

  const handleRefresh = (): void => {
    if (existingMode) {
      existingWorktrees.onRefresh();
      return;
    }
    onRefreshOptions();
  };

  const refreshing = existingMode ? existingWorktrees.loading : loadingOptions;
  const hasSelection = existingMode
    ? existingWorktrees.canSubmit
    : selectedWorkspaceIds.length > 0;
  // A host whose combine is not saved server-side cannot be dismissed mid-run.
  const dismissLocked = submitting && !dismissWhileSubmitting;
  const submitDisabled =
    submitting ||
    submitBlocked ||
    (existingMode
      ? existingWorktrees.loading || !existingWorktrees.canSubmit
      : loadingOptions ||
        workspaceOptions.length === 0 ||
        selectedWorkspaceIds.length === 0);

  return (
    <DialogModal
      onClose={onClose}
      title="Add project"
      titleId="add-repo-to-worktree-title"
      maxWidth="xl"
      dataTestId="add-repo-to-worktree-modal"
      closeOnBackdrop={!dismissLocked}
      closeButtonDisabled={dismissLocked}
      footer={
        <>
          <Button
            size="compact"
            onClick={onClose}
            disabled={dismissLocked}
            data-testid="add-repo-to-worktree-modal-cancel"
            ref={dismissRef}
          >
            {dismissLabel}
          </Button>
          {savedAttempt?.onCancel ? (
            <Button
              size="compact"
              onClick={savedAttempt.onCancel}
              disabled={savedAttempt.cancelling}
              data-testid="add-repo-to-worktree-modal-cancel-attempt"
              ref={cancelAttemptRef}
            >
              {savedAttempt.cancelling ? 'Cancelling…' : 'Cancel combining'}
            </Button>
          ) : null}
          {savedAttempt?.onResume ? (
            <Button
              variant="primary"
              size="compact"
              onClick={savedAttempt.onResume}
              disabled={savedAttempt.resuming || savedAttempt.cancelling}
              data-testid="add-repo-to-worktree-modal-resume"
              ref={resumeRef}
            >
              {savedAttempt.resuming ? 'Combining…' : 'Resume'}
            </Button>
          ) : null}
          {savedAttempt ? null : (
            <Button
              variant="primary"
              size="compact"
              onClick={existingMode ? existingWorktrees.onSubmit : onCombine}
              disabled={submitDisabled}
              data-testid="add-repo-to-worktree-modal-submit"
            >
              {existingMode
                ? submitting
                  ? 'Joining…'
                  : 'Join worktree'
                : submitting
                  ? 'Combining…'
                  : 'Combine'}
            </Button>
          )}
        </>
      }
    >
      <fieldset
        disabled={submitting}
        className="flex min-w-0 flex-col gap-4 text-s"
      >
        {savedAttempt ? (
          <Notice
            errorSource="add-repo-to-worktree-modal-saved-attempt"
            intent={savedAttempt.intent}
            title={savedAttempt.title}
            ref={attemptNoticeRef}
            tabIndex={-1}
            data-testid="add-repo-to-worktree-modal-saved-attempt"
          >
            {savedAttempt.message}
          </Notice>
        ) : null}
        {savedAttempt ? null : (
          <div
            className={`flex items-center gap-2 ${
              existingWorktrees ? 'justify-between' : 'justify-end'
            }`}
          >
            {existingWorktrees ? (
              <SegmentedControl<AddRepositoryPickerMode>
                label="Worktrees to add"
                value={pickerMode}
                width="content"
                shape="capsule"
                options={PICKER_MODE_OPTIONS}
                onChange={onPickerModeChange}
              />
            ) : null}
            <Tooltip label="Refresh">
              <Button
                variant="ghost"
                size="compact"
                iconOnly
                onClick={handleRefresh}
                disabled={refreshing}
                data-testid="add-repo-to-worktree-modal-refresh"
                aria-label="Refresh"
              >
                <RefreshSpinnerIcon spinning={refreshing} />
              </Button>
            </Tooltip>
          </div>
        )}

        {savedAttempt ? null : existingMode ? (
          existingWorktrees.content
        ) : (
          <>
            <p className="text-xs fg-secondary">{newWorktreesDescription}</p>

            {!loadingOptions && workspaceOptions.length === 0 ? (
              <EmptyState
                testId="add-repo-to-worktree-modal-empty"
                title="No eligible projects"
                subtitle="Add a project with at least one repo that is not already here."
              />
            ) : (
              <WorkspaceMultiSelectPicker
                options={workspaceOptions}
                selectedWorkspaceIds={selectedWorkspaceIds}
                onToggleWorkspace={handleToggleWorkspace}
                searchQuery={searchQuery}
                onSearchQueryChange={setSearchQuery}
                testIdPrefix="add-repo-to-worktree-modal"
                listHeight="viewport"
                renderOptionIcon={renderOptionIcon}
                loading={loadingOptions}
                loadingSlowNote="Still loading projects…"
              />
            )}
          </>
        )}

        {!savedAttempt && hasSelection ? selectionAccessory : null}
        {notices}

        {/* Command output can name paths and branches. */}
        <ErrorBanner
          errorSource="add-repo-to-worktree-modal-error"
          className=""
          error={errorMessage}
          blockMessageFromReplay
          testId="add-repo-to-worktree-modal-error"
          {...(errorDetails === undefined ? {} : { details: errorDetails })}
          {...(onErrorRetry ? { onRetry: onErrorRetry } : {})}
          {...(errorDisplayPolicy ? { displayPolicy: errorDisplayPolicy } : {})}
          {...(renderErrorReportAction
            ? { reportAction: renderErrorReportAction }
            : {})}
        />
      </fieldset>
    </DialogModal>
  );
}
