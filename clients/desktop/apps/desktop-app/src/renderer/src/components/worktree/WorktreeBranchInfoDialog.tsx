import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import type {
  RepoBranchInfo,
  WorkspaceRepoData,
  WorktreeData,
  WorktreeHealthIssue,
} from '@canopy/desktop-shared/types';
import type { PipelineInfo } from '@canopy/execution-engine/types/pipeline';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useClipboardCopy } from '@/hooks/useClipboardCopy';
import { BaseBranchDropdown } from './BaseBranchDropdown';
import { BranchPicker } from './BranchPicker';
import { LabelField } from './LabelField';
import { resolveDisplayedBaseBranch } from './branch-options';
import { refreshWorktreeActivity } from './refresh-worktree-activity';
import { CopyButton } from '../shared/CopyButton';
import { LoadingSpinner } from '../shared/loading/spinners/LoadingSpinner';
import { CodeGraphSummaryPanel } from './CodeGraphSummaryPanel';
import { GraphIcon } from '@canopy/ui-shared/icons';
import {
  PencilIcon as AppCatalogPencilIcon,
  ChevronDownMediumIcon as AppCatalogChevronDownMediumIcon,
  CheckIcon as AppCatalogCheckIcon,
  Copy as AppCatalogCopy,
} from '@canopy/ui-shared/icons/AppIcons';
import { useCodeGraphExperimentEnabled } from '@/hooks/useCodeGraphExperimentEnabled';
import { useCodeGraphBuildStore } from '@/stores/codeGraphBuildStore';
import { Tooltip } from '@canopy/ui-shared';
import {
  Stack,
  Button,
  DialogModal,
  FieldError,
  Notice,
  NoticeButton,
  Surface,
  TabBar,
  TextInput,
} from '@canopy/ui-shared/components';
import {
  DelayedLoadingPlaceholder,
  EmptyState,
  Fact,
  FactList,
  Skeleton,
} from '@canopy/ui-shared/components';
import { RichHoverTooltip } from '@/components/shared/RichHoverTooltip';

type BranchInfoTab = 'details' | 'pipelines' | 'code-graph';
type WorktreeDirectoryStatus = 'idle' | 'loading' | 'loaded' | 'error';

/**
 * Renders the per-repo provenance badge (`local` / `remote`) when the base
 * branch only resolves on one side.
 */
function getBaseBranchProvenance(params: {
  existsLocally: boolean | undefined;
  existsInRemote: boolean | undefined;
}): { label: 'local' | 'remote'; className: string } | null {
  const { existsLocally, existsInRemote } = params;
  if (existsLocally === true && existsInRemote === false) {
    return { label: 'local', className: 'fg-warning' };
  }
  if (existsLocally === false && existsInRemote === true) {
    return { label: 'remote', className: 'fg-success' };
  }
  return null;
}

/**
 * Multi-repo equivalent — only returns a label when every repo whose
 * base branch matches `sharedBaseBranch` agrees on the provenance side.
 */
function getSharedBaseBranchProvenance(
  repoBranches: RepoBranchInfo[] | undefined,
  sharedBaseBranch: string | null,
): { label: 'local' | 'remote'; className: string } | null {
  if (!repoBranches || !sharedBaseBranch) {
    return null;
  }
  const matchingBaseBranches = repoBranches.filter(
    (repoBranch) => repoBranch.baseBranch === sharedBaseBranch,
  );
  if (matchingBaseBranches.length === 0) {
    return null;
  }
  const allLocalOnly = matchingBaseBranches.every(
    (repoBranch) =>
      repoBranch.baseBranchExistsLocally === true &&
      repoBranch.baseBranchExistsInRemote === false,
  );
  if (allLocalOnly) {
    return { label: 'local', className: 'fg-warning' };
  }
  const allRemoteOnly = matchingBaseBranches.every(
    (repoBranch) =>
      repoBranch.baseBranchExistsLocally === false &&
      repoBranch.baseBranchExistsInRemote === true,
  );
  if (allRemoteOnly) {
    return { label: 'remote', className: 'fg-success' };
  }
  return null;
}

interface WorktreeHealthAlertProps {
  issue: WorktreeHealthIssue;
  retrying: boolean;
  retryError: string | null;
  onRetry: () => void;
}

function WorktreeHealthAlert({
  issue,
  retrying,
  retryError,
  onRetry,
}: WorktreeHealthAlertProps): JSX.Element {
  const hasDetail = Boolean(issue.gitError) || Boolean(retryError);
  return (
    <Notice
      className=""
      intent="attention"
      title="Health check warning"
      {...(hasDetail
        ? {
            detail: (
              <>
                {issue.gitError && (
                  <p
                    className={`${POSTHOG_REPLAY_BLOCK_CLASS} whitespace-pre-wrap break-words font-mono`}
                  >
                    {issue.gitError}
                  </p>
                )}
                {retryError && (
                  <p
                    className={`${POSTHOG_REPLAY_BLOCK_CLASS} whitespace-pre-wrap break-words`}
                  >
                    {retryError}
                  </p>
                )}
              </>
            ),
          }
        : {})}
      // The status chip rides in the trailing slot beside the action: the
      // title is inline text now, so a flex row inside it would break the
      // line.
      actions={
        <>
          <span className="rounded bg-warning-subtle px-1.5 py-0.5 text-xs font-medium fg-primary">
            Broken
          </span>
          <NoticeButton variant="primary" onClick={onRetry} disabled={retrying}>
            {retrying && <LoadingSpinner />}
            <span>{retrying ? 'Trying again' : 'Try again'}</span>
          </NoticeButton>
        </>
      }
    >
      {issue.message}
    </Notice>
  );
}

function formatHealthRetryError(
  issue: WorktreeHealthIssue | undefined,
): string {
  const issueMessage = issue?.message.trim() ?? '';
  const gitError = issue?.gitError?.trim() ?? '';
  if (!issueMessage) {
    return 'Still broken after retry.';
  }
  if (gitError && gitError !== issueMessage) {
    return `${issueMessage} (${gitError})`;
  }
  return issueMessage;
}

const SAMPLE_PIPELINE_TIME = '2026-01-01T12:00:00.000Z';

function samplePipeline(
  id: string,
  name: string,
  description: string,
): PipelineInfo {
  return {
    id,
    name,
    filename: `${id}.yaml`,
    description,
    icon: '',
    createdAt: SAMPLE_PIPELINE_TIME,
    updatedAt: SAMPLE_PIPELINE_TIME,
    source: 'project',
    readonly: true,
  };
}

/** Plain workflows the loading skeleton lays out as the workflow rows. */
const SAMPLE_PIPELINES: PipelineInfo[] = [
  samplePipeline('skeleton-review', 'Code review', 'Reviews the open changes'),
  samplePipeline(
    'skeleton-release',
    'Release notes',
    'Drafts notes from commits',
  ),
  samplePipeline(
    'skeleton-tests',
    'Run the tests',
    'Runs the suite and reports',
  ),
];

const noop = (): void => undefined;

function ProjectPipelineRows({
  pipelines,
  onView,
}: {
  pipelines: PipelineInfo[];
  onView: (pipeline: PipelineInfo) => void;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      {pipelines.map((p) => (
        <Surface variant="outline" key={p.id}>
          <div className="flex items-center gap-3 px-3 py-2">
            <span className="shrink-0 text-m">{p.icon || '⚡'}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-s font-medium fg-primary">
                {p.name}
              </div>
              {p.description && (
                <div className="truncate text-xs fg-secondary">
                  {p.description}
                </div>
              )}
            </div>
            <Button size="compact" onClick={() => onView(p)}>
              View
            </Button>
          </div>
        </Surface>
      ))}
    </div>
  );
}

function ProjectPipelineList({
  pipelines,
  loading,
  onView,
}: {
  pipelines: PipelineInfo[];
  loading: boolean;
  onView: (pipeline: PipelineInfo) => void;
}): JSX.Element {
  if (loading) {
    return (
      <DelayedLoadingPlaceholder slowNote="Still loading workflows…">
        <Skeleton
          loading
          label="Loading workflows"
          testId="worktree-branch-info-workflows-loading"
        >
          <ProjectPipelineRows pipelines={SAMPLE_PIPELINES} onView={noop} />
        </Skeleton>
      </DelayedLoadingPlaceholder>
    );
  }

  if (pipelines.length === 0) {
    return (
      <div className="flex flex-col gap-1 py-6 text-center text-xs fg-secondary">
        <p>No project workflows found.</p>
        <p className="text-3xs">
          Add YAML files to <code>.canopy/pipelines/</code> in your repo.
        </p>
      </div>
    );
  }

  return <ProjectPipelineRows pipelines={pipelines} onView={onView} />;
}

const BRANCH_INFO_TAB_LABELS: Readonly<Record<BranchInfoTab, string>> = {
  details: 'Details',
  pipelines: 'Workflows',
  'code-graph': 'Code Graph',
};

function BranchInfoTabs({
  active,
  onChange,
  codeGraphEnabled,
}: {
  active: BranchInfoTab;
  onChange: (tab: BranchInfoTab) => void;
  codeGraphEnabled: boolean;
}): JSX.Element {
  const tabs: BranchInfoTab[] = codeGraphEnabled
    ? ['details', 'pipelines', 'code-graph']
    : ['details', 'pipelines'];
  return (
    <TabBar
      className=""
      items={tabs.map((tab) => ({
        id: tab,
        label: BRANCH_INFO_TAB_LABELS[tab],
        icon: tab === 'code-graph' ? <GraphIcon size="sm" /> : undefined,
      }))}
      value={active}
      onChange={(next): void => onChange(next)}
      label="Branch details"
      density="compact"
    />
  );
}

/** The path a loading directory is measured from: a typical worktree. */
const SAMPLE_WORKTREE_DIRECTORY = '~/.canopy/worktrees/canopy/feature-branch';

/**
 * The directory path, truncated from the start so its end stays visible;
 * no path reads "Unavailable".
 */
function DirectoryPath({ path }: { path: string | null }): JSX.Element {
  return (
    <span
      className="min-w-0 truncate font-mono"
      style={{
        direction: 'rtl',
        textAlign: 'left',
      }}
      title={path ?? undefined}
    >
      {path ? `\u200e${path}` : 'Unavailable'}
    </span>
  );
}

interface DirectoryFactProps {
  worktreeDirectory: string | null;
  worktreeDirectoryStatus: WorktreeDirectoryStatus;
}

/**
 * The worktree's directory as one fact, its Copy button right after the path
 * (design call 7A, 2026-10-31). The path keeps its end visible: it truncates
 * from the start.
 */
function DirectoryFact({
  worktreeDirectory,
  worktreeDirectoryStatus,
}: DirectoryFactProps): JSX.Element {
  return (
    <div>
      <FactList columnGap="3" labelTone="secondary">
        <Fact label="Directory" fit="row" dataTestId="worktree-directory-fact">
          {worktreeDirectory || worktreeDirectoryStatus === 'error' ? (
            <DirectoryPath path={worktreeDirectory} />
          ) : (
            <Skeleton
              loading
              label="Loading worktree directory"
              className="min-w-0"
            >
              <DirectoryPath path={SAMPLE_WORKTREE_DIRECTORY} />
            </Skeleton>
          )}
          {worktreeDirectory && (
            <CopyButton
              value={worktreeDirectory}
              ariaLabel="Copy worktree directory"
              title="Copy worktree directory"
            />
          )}
        </Fact>
      </FactList>
    </div>
  );
}

interface RemoteRenameWarningProps {
  message: string;
  /** Label for the confirm button when not loading. Existing copy variants are
   * `Rename anyway` (single repo or per-repo in multi-repo) and
   * `Rename all anyway` (rename-all in multi-repo modal). */
  confirmLabel: 'Rename anyway' | 'Rename all anyway';
  loading: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function RemoteRenameWarning({
  message,
  confirmLabel,
  loading,
  onCancel,
  onConfirm,
}: RemoteRenameWarningProps): JSX.Element {
  return (
    <Notice
      className=""
      intent="attention"
      actions={
        <>
          <NoticeButton variant="secondary" onClick={onCancel}>
            Cancel
          </NoticeButton>
          <NoticeButton
            variant="primary"
            disabled={loading}
            onClick={onConfirm}
          >
            {loading ? 'Renaming…' : confirmLabel}
          </NoticeButton>
        </>
      }
    >
      {message}
    </Notice>
  );
}

interface BranchRenameFormProps {
  /** Stable ref so callers can preserve focus after re-rendering. */
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (next: string) => void;
  loading: boolean;
  error: string | null;
  /** Submit label: `Save` for per-branch rename, `Rename All` when renaming
   * every repo's branch in a multi-repo workspace. */
  submitLabel: 'Save' | 'Rename all';
  ariaLabel: string;
  onSubmit: () => void;
  onCancel: () => void;
  /** When true, the warning panel below is shown instead of triggering an
   * immediate rename — the parent surfaces it via {@link RemoteRenameWarning}. */
  confirmRemote: boolean;
  warningMessage: string;
  /** Confirmation button text inside the warning panel. */
  warningConfirmLabel: 'Rename anyway' | 'Rename all anyway';
  onWarningConfirm: () => void;
}

function BranchRenameForm({
  inputRef,
  value,
  onChange,
  loading,
  error,
  submitLabel,
  ariaLabel,
  onSubmit,
  onCancel,
  confirmRemote,
  warningMessage,
  warningConfirmLabel,
  onWarningConfirm,
}: BranchRenameFormProps): JSX.Element {
  const errorId = useId();
  return (
    <Stack gap="inline">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <TextInput
            ref={inputRef}
            density="compact"
            mono
            className="min-w-0 flex-1"
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter') {
                onSubmit();
              } else if (e.key === 'Escape') {
                onCancel();
              }
            }}
            disabled={loading}
            aria-label={ariaLabel}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
          />
          <Button
            variant="primary"
            size="compact"
            disabled={loading}
            onClick={onSubmit}
          >
            {loading ? 'Saving…' : submitLabel}
          </Button>
          <Button size="compact" onClick={onCancel} disabled={loading}>
            Cancel
          </Button>
        </div>
        {error && (
          <div>
            <FieldError id={errorId}>{error}</FieldError>
          </div>
        )}
      </div>
      {confirmRemote && (
        <RemoteRenameWarning
          message={warningMessage}
          confirmLabel={warningConfirmLabel}
          loading={loading}
          onCancel={onCancel}
          onConfirm={onWarningConfirm}
        />
      )}
    </Stack>
  );
}

interface BranchActionButtonsProps {
  branch: string;
  copyKey: string;
  copiedBranch: string | null;
  disabled: boolean;
  onSwitchBranchClick: () => void;
  onRenameClick: () => void;
  onCopyClick: (e: MouseEvent<HTMLButtonElement>) => void;
}

function BranchActionButtons({
  branch,
  copyKey,
  copiedBranch,
  disabled,
  onSwitchBranchClick,
  onRenameClick,
  onCopyClick,
}: BranchActionButtonsProps): JSX.Element {
  return (
    <>
      {/* RichHoverTooltip (not Tooltip): its wrapper carries no `shrink-0`,
          so the branch name can still truncate inside the row. */}
      <RichHoverTooltip
        triggerWrapperClassName="min-w-0"
        surfaceClassName="w-max"
        surfacePadding="compact"
        content={<span className="text-xs fg-primary">Switch branch</span>}
      >
        <Button
          size="compact"
          disabled={disabled}
          onClick={onSwitchBranchClick}
          className="min-w-0 max-w-full"
          aria-label={
            copyKey === 'single' ? 'Switch branch' : `Switch branch ${branch}`
          }
        >
          <span className="truncate font-mono">{branch}</span>
          <AppCatalogChevronDownMediumIcon size={14} className="shrink-0" />
        </Button>
      </RichHoverTooltip>
      <Tooltip label="Rename branch">
        <Button
          variant="ghost"
          size="compact"
          iconOnly
          disabled={disabled}
          onClick={onRenameClick}
          aria-label={
            copyKey === 'single' ? 'Rename branch' : `Rename branch ${branch}`
          }
        >
          <AppCatalogPencilIcon size={14} />
        </Button>
      </Tooltip>
      <Tooltip
        label={copiedBranch === copyKey ? 'Copied' : `Copy branch ${branch}`}
      >
        <Button
          variant="ghost"
          size="compact"
          iconOnly
          onClick={onCopyClick}
          aria-label={
            copiedBranch === copyKey ? 'Copied' : `Copy branch ${branch}`
          }
        >
          {copiedBranch === copyKey ? (
            <AppCatalogCheckIcon size={14} />
          ) : (
            <AppCatalogCopy size={14} />
          )}
        </Button>
      </Tooltip>
    </>
  );
}

interface RepoBranchRowProps {
  rb: RepoBranchInfo;
  isRenamingThis: boolean;
  pickerOpen: boolean;
  copiedBranch: string | null;
  branchMutationsDisabled: boolean;
  projectId: string;
  worktreeId: string;
  renameInputRef: RefObject<HTMLInputElement | null>;
  renameValue: string;
  renameError: string | null;
  renameLoading: boolean;
  renameConfirmRemote: boolean;
  onRenameChange: (next: string) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
  onRenameWarningConfirm: () => void;
  onSwitchBranchClick: () => void;
  onRenameClick: () => void;
  onCopyClick: (e: MouseEvent<HTMLButtonElement>) => void;
  onBranchSwitched: () => void;
  onBaseBranchChange: (
    branchName: string,
    presence?: { existsLocally: boolean; existsInRemote: boolean },
  ) => void;
  onClosePicker: () => void;
}

function RepoBranchRow({
  rb,
  isRenamingThis,
  pickerOpen,
  copiedBranch,
  branchMutationsDisabled,
  projectId,
  worktreeId,
  renameInputRef,
  renameValue,
  renameError,
  renameLoading,
  renameConfirmRemote,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
  onRenameWarningConfirm,
  onSwitchBranchClick,
  onRenameClick,
  onCopyClick,
  onBranchSwitched,
  onBaseBranchChange,
  onClosePicker,
}: RepoBranchRowProps): JSX.Element {
  const repoHasChanges = (rb.insertions ?? 0) + (rb.deletions ?? 0) > 0;
  const baseBranchProvenance = getBaseBranchProvenance({
    existsLocally: rb.baseBranchExistsLocally,
    existsInRemote: rb.baseBranchExistsInRemote,
  });

  return (
    <Surface variant="outline">
      <div className="flex flex-col px-3 py-2 gap-2">
        <Stack gap="tight">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <span
              className="shrink-0 text-s font-medium fg-primary"
              title={rb.repoName}
            >
              {rb.repoName}
            </span>
            <span className="flex min-w-0 items-center gap-1.5">
              {repoHasChanges && (
                <span className="inline-flex items-center gap-1 text-xs font-semibold tabular-nums">
                  <span className="fg-success">+{rb.insertions}</span>
                  <span className="fg-destructive">-{rb.deletions}</span>
                </span>
              )}
              {!isRenamingThis && (
                <BranchActionButtons
                  branch={rb.branch}
                  copyKey={rb.repoId}
                  copiedBranch={copiedBranch}
                  disabled={branchMutationsDisabled}
                  onSwitchBranchClick={onSwitchBranchClick}
                  onRenameClick={onRenameClick}
                  onCopyClick={onCopyClick}
                />
              )}
            </span>
          </div>
          {!isRenamingThis && (
            <div className="flex items-center gap-2">
              <span className="text-3xs fg-secondary">base:</span>
              <div className="min-w-0 flex-1">
                <BaseBranchDropdown
                  projectId={projectId}
                  worktreeId={worktreeId}
                  repoId={rb.repoId}
                  currentValue={rb.baseBranch ?? null}
                  disabled={branchMutationsDisabled}
                  onChange={onBaseBranchChange}
                />
              </div>
              {baseBranchProvenance && (
                <span
                  className={`shrink-0 text-3xs ${baseBranchProvenance.className}`}
                >
                  {baseBranchProvenance.label}
                </span>
              )}
            </div>
          )}
          {!isRenamingThis && pickerOpen && (
            <div>
              <BranchPicker
                projectId={projectId}
                worktreeId={worktreeId}
                repoId={rb.repoId}
                baseBranch={rb.baseBranch}
                onBranchSwitched={onBranchSwitched}
                onClose={onClosePicker}
              />
            </div>
          )}
        </Stack>
        {isRenamingThis && (
          <div>
            <BranchRenameForm
              inputRef={renameInputRef}
              value={renameValue}
              onChange={onRenameChange}
              loading={renameLoading}
              error={renameError}
              submitLabel="Save"
              ariaLabel="New branch name"
              onSubmit={onRenameSubmit}
              onCancel={onRenameCancel}
              confirmRemote={renameConfirmRemote}
              warningMessage="This branch has already been pushed to remote. Renaming will only change the local branch name — the old remote branch and any associated PRs will still exist."
              warningConfirmLabel="Rename anyway"
              onWarningConfirm={onRenameWarningConfirm}
            />
          </div>
        )}
      </div>
    </Surface>
  );
}

interface BranchInfoModalFrameProps {
  /** DOM id used for `aria-labelledby` on the dialog. */
  titleId: string;
  title: string;
  /** Single-repo uses `md`; multi-repo uses `xl`. */
  maxWidth: 'md' | 'xl';
  /** Header actions beside the close button. */
  headerActions?: ReactNode;
  /** Whether Escape cancels an open rename instead of closing the dialog. */
  escapeFirstClosesRename: boolean;
  onCancelRename: () => void;
  /** Closes the dialog and drops any open rename. */
  onClose: () => void;
  children: ReactNode;
}

/**
 * The branch info dialog is the shared `DialogModal`, so it portals out of the
 * sidebar's backdrop-filter containing block and takes Escape, the backdrop
 * and the close button like every dialog. While a branch rename is open,
 * Escape cancels the rename first.
 */
function BranchInfoModalFrame({
  titleId,
  title,
  maxWidth,
  headerActions,
  escapeFirstClosesRename,
  onCancelRename,
  onClose,
  children,
}: BranchInfoModalFrameProps): JSX.Element {
  return (
    <DialogModal
      onClose={onClose}
      title={title}
      titleId={titleId}
      maxWidth={maxWidth}
      headerBorder={false}
      inset="flush"
      topRightActions={headerActions}
    >
      {/* Git error output is blocked. */}
      <div
        className="flex flex-col gap-3 px-6 pb-6"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && escapeFirstClosesRename) {
            // The dialog's own Escape skips a handled event.
            e.preventDefault();
            onCancelRename();
          }
        }}
      >
        {children}
      </div>
    </DialogModal>
  );
}

export interface WorktreeBranchInfoDialogPendingRename {
  /** `'single'`, `'all'`, or a repoId — must match the form selection scheme. */
  id: string;
  branch: string;
}

export interface WorktreeBranchInfoDialogProps {
  open: boolean;
  worktree: WorktreeData;
  projectId: string;
  isMultiRepo?: boolean;
  repoBranches?: RepoBranchInfo[];
  configRepos?: WorkspaceRepoData[];
  /** Single-repo only. Whether the worktree branch has been pushed to remote
   * — controls the rename remote-confirmation warning. */
  hasBranchBeenPushed?: boolean;
  baseBranch?: string | null;
  baseBranchExistsLocally?: boolean;
  baseBranchExistsInRemote?: boolean;
  /** Prevent Git branch mutations while checkout or setup scripts are active. */
  branchMutationsDisabled?: boolean;
  onAddRepoToWorktree?: (
    worktreeId: string,
    repoId: string,
  ) => void | Promise<void>;
  onRemoveRepoFromWorktree?: (
    worktreeId: string,
    repoId: string,
  ) => void | Promise<void>;
  onClose: () => void;
  /** When set, the dialog opens (or, if already open, switches) directly into
   * a rename flow seeded with this id/branch, then calls
   * {@link onPendingRenameConsumed} so the parent can clear its request. */
  pendingRename?: WorktreeBranchInfoDialogPendingRename | null;
  onPendingRenameConsumed?: () => void;
  /**
   * Generated fallback shown by the Label field when no custom label is set
   * (the computed branch display name used as the sidebar row's primary name).
   */
  labelFallback?: string;
  /** When set, open directly into the Label edit flow with the input focused. */
  pendingLabelEdit?: boolean;
  /** Called once the `pendingLabelEdit` request has been consumed. */
  onPendingLabelEditConsumed?: () => void;
}

export function WorktreeBranchInfoDialog({
  open,
  worktree,
  projectId,
  isMultiRepo,
  repoBranches,
  configRepos,
  hasBranchBeenPushed,
  baseBranch,
  baseBranchExistsLocally,
  baseBranchExistsInRemote,
  branchMutationsDisabled = false,
  onAddRepoToWorktree,
  onRemoveRepoFromWorktree,
  onClose,
  pendingRename,
  onPendingRenameConsumed,
  labelFallback,
  pendingLabelEdit,
  onPendingLabelEditConsumed,
}: WorktreeBranchInfoDialogProps): JSX.Element | null {
  const { copiedKey: copiedBranch, copy: copyBranch } = useClipboardCopy();
  const setWorktreeLabel = useProjectsStore((state) => state.setWorktreeLabel);
  const [labelEditRequested, setLabelEditRequested] = useState(false);

  // Branch rename state
  const [renamingBranch, setRenamingBranch] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameLoading, setRenameLoading] = useState(false);
  const [renameConfirmRemote, setRenameConfirmRemote] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const [branchPickerOpen, setBranchPickerOpen] = useState<string | null>(null);

  const [branchInfoTab, setBranchInfoTab] = useState<BranchInfoTab>('details');
  const [projectPipelines, setProjectPipelines] = useState<PipelineInfo[]>([]);
  const [pipelinesLoading, setPipelinesLoading] = useState(false);

  const codeGraphExperimentEnabled = useCodeGraphExperimentEnabled();
  // Live "building" flag for this worktree's code graph, keyed
  // `${projectId}/${worktreeId}`, so the panel reflects a build already running
  // (started elsewhere) and refreshes when it finishes.
  const isBuildingCodeGraph = useCodeGraphBuildStore(
    (state) => state.building[`${projectId}/${worktree.id}`] === true,
  );
  // If the flag flips off while the Code Graph tab is active, fall back to
  // Details so a hidden tab's panel never lingers.
  const effectiveBranchInfoTab: BranchInfoTab =
    branchInfoTab === 'code-graph' && !codeGraphExperimentEnabled
      ? 'details'
      : branchInfoTab;

  const openCodeGraphSettings = useCallback((): void => {
    onClose();
    useNavigationStore.getState().openSettings('code-graph');
  }, [onClose]);

  const codeGraphPanel = (
    <div>
      <CodeGraphSummaryPanel
        advisorContext={{
          scope: 'worktree',
          workspaceId: projectId,
          worktreeId: worktree.id,
        }}
        load={(): ReturnType<typeof window.api.codeGraphGetWorktreeSummary> =>
          window.api.codeGraphGetWorktreeSummary({
            workspaceId: projectId,
            worktreeId: worktree.id,
          })
        }
        build={(): ReturnType<typeof window.api.codeGraphBuildWorktree> =>
          window.api.codeGraphBuildWorktree({
            workspaceId: projectId,
            worktreeId: worktree.id,
          })
        }
        onOpenSettings={openCodeGraphSettings}
        externalBuilding={isBuildingCodeGraph}
      />
    </div>
  );

  const [worktreeDirectory, setWorktreeDirectory] = useState<string | null>(
    null,
  );
  const [worktreeDirectoryStatus, setWorktreeDirectoryStatus] =
    useState<WorktreeDirectoryStatus>('idle');

  const [healthRetrying, setHealthRetrying] = useState(false);
  const [healthRetryError, setHealthRetryError] = useState<string | null>(null);
  const healthRetryAttemptRef = useRef(0);

  const [addingRepoId, setAddingRepoId] = useState<string | null>(null);
  const [removingRepoId, setRemovingRepoId] = useState<string | null>(null);

  const startRename = useCallback((id: string, currentBranch: string): void => {
    setRenamingBranch(id);
    setRenameValue(currentBranch);
    setRenameError(null);
    setRenameConfirmRemote(false);
    setTimeout(() => {
      const input = renameInputRef.current;
      if (input) {
        input.focus();
        input.select();
      }
    }, 0);
  }, []);

  const cancelRename = useCallback((): void => {
    setRenamingBranch(null);
    setRenameValue('');
    setRenameError(null);
    setRenameConfirmRemote(false);
  }, []);

  useEffect(() => {
    if (!branchMutationsDisabled) return;
    cancelRename();
    setBranchPickerOpen(null);
  }, [branchMutationsDisabled, cancelRename]);

  // Reset transient modal state every time the dialog opens.
  useEffect(() => {
    if (open) {
      setBranchInfoTab('details');
      setProjectPipelines([]);
    }
  }, [open]);

  // Reset modal-only health retry state when it closes.
  useEffect(() => {
    if (open) return;
    healthRetryAttemptRef.current += 1;
    setHealthRetrying(false);
    setHealthRetryError(null);
  }, [open]);

  // Clear cached retry-error whenever the underlying issue changes upstream.
  useEffect(() => {
    setHealthRetryError(null);
  }, [
    worktree.healthIssue?.checkedAt,
    worktree.healthIssue?.code,
    worktree.healthIssue?.gitError,
    worktree.healthIssue?.message,
    worktree.healthIssue?.worktreePath,
  ]);

  // Load worktree directory while the modal is open.
  useEffect(() => {
    if (!open) {
      setWorktreeDirectory(null);
      setWorktreeDirectoryStatus('idle');
      return;
    }
    setWorktreeDirectoryStatus('loading');
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const dir = await window.api.getWorktreePath({
          projectId,
          worktreeId: worktree.id,
        });
        if (!cancelled) {
          setWorktreeDirectory(dir.replace(/\/+$/, ''));
          setWorktreeDirectoryStatus('loaded');
        }
      } catch {
        if (!cancelled) {
          setWorktreeDirectory(null);
          setWorktreeDirectoryStatus('error');
        }
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [open, projectId, worktree.id]);

  // Load project pipelines when switching to the pipelines tab.
  useEffect(() => {
    if (!open || branchInfoTab !== 'pipelines') return;
    let cancelled = false;

    async function discover(): Promise<void> {
      setPipelinesLoading(true);
      try {
        const cwd = await window.api.getWorktreePath({
          projectId,
          worktreeId: worktree.id,
        });
        const result = await window.pipelines.discoverProject(cwd);
        if (!cancelled && result.success && result.data) {
          setProjectPipelines(result.data);
        }
      } catch {
        // Swallow — empty list is fine
      } finally {
        if (!cancelled) setPipelinesLoading(false);
      }
    }

    void discover();
    return (): void => {
      cancelled = true;
    };
  }, [open, branchInfoTab, projectId, worktree.id]);

  // Consume external "open with rename" requests from the store. The parent
  // sets `pendingRename` and invokes `onPendingRenameConsumed` once we've
  // primed the rename form so it doesn't fire repeatedly.
  useEffect(() => {
    if (!open || !pendingRename) return;
    if (!branchMutationsDisabled) {
      startRename(pendingRename.id, pendingRename.branch);
    }
    onPendingRenameConsumed?.();
  }, [
    open,
    pendingRename,
    branchMutationsDisabled,
    startRename,
    onPendingRenameConsumed,
  ]);

  // Consume external "open into label edit" requests (the "Set label" action).
  useEffect(() => {
    if (!open || !pendingLabelEdit) return;
    setBranchInfoTab('details');
    setLabelEditRequested(true);
    onPendingLabelEditConsumed?.();
  }, [open, pendingLabelEdit, onPendingLabelEditConsumed]);

  const handleRetryHealthCheck = useCallback(async (): Promise<void> => {
    const attemptId = healthRetryAttemptRef.current + 1;
    healthRetryAttemptRef.current = attemptId;
    setHealthRetrying(true);
    setHealthRetryError(null);
    try {
      const response = await useProjectsStore
        .getState()
        .retryWorktreeHealthCheck(projectId, worktree.id);
      if (healthRetryAttemptRef.current !== attemptId) {
        return;
      }
      if (!response.healthy) {
        setHealthRetryError(formatHealthRetryError(response.issue));
      }
    } catch (error) {
      if (healthRetryAttemptRef.current !== attemptId) {
        return;
      }
      setHealthRetryError(
        error instanceof Error ? error.message : 'Health check retry failed.',
      );
    } finally {
      if (healthRetryAttemptRef.current === attemptId) {
        setHealthRetrying(false);
      }
    }
  }, [projectId, worktree.id]);

  const handleBranchSwitched = useCallback(async (): Promise<void> => {
    await refreshWorktreeActivity(projectId, worktree.id);
    setBranchPickerOpen(null);
  }, [projectId, worktree.id]);

  const handleCopyBranch = useCallback(
    (
      repoId: string,
      branch: string,
      e: MouseEvent<HTMLButtonElement>,
    ): void => {
      e.stopPropagation();
      void copyBranch(branch, repoId);
    },
    [copyBranch],
  );

  const handleRenameBranch = useCallback(
    async (
      repoId: string | undefined,
      currentBranch: string,
      isPushedToRemote: boolean,
    ): Promise<void> => {
      const trimmed = renameValue.trim();
      if (!trimmed || trimmed === currentBranch) {
        cancelRename();
        return;
      }
      if (isPushedToRemote && !renameConfirmRemote) {
        setRenameConfirmRemote(true);
        return;
      }
      setRenameLoading(true);
      setRenameError(null);
      try {
        await window.api.renameBranch({
          projectId,
          worktreeId: worktree.id,
          newBranchName: trimmed,
          repoId,
        });
        useProjectsStore
          .getState()
          .updateBranchName(projectId, worktree.id, trimmed, repoId);
        cancelRename();
        void useProjectsStore.getState().refreshDiffStats();
      } catch (err: unknown) {
        setRenameError(
          err instanceof Error ? err.message : 'Failed to rename branch',
        );
      } finally {
        setRenameLoading(false);
      }
    },
    [renameValue, projectId, worktree.id, renameConfirmRemote, cancelRename],
  );

  const handleRenameAll = useCallback(
    async (isPushedToRemote: boolean): Promise<void> => {
      const trimmed = renameValue.trim();
      if (!trimmed || !repoBranches || repoBranches.length === 0) {
        cancelRename();
        return;
      }
      if (isPushedToRemote && !renameConfirmRemote) {
        setRenameConfirmRemote(true);
        return;
      }
      setRenameLoading(true);
      setRenameError(null);
      try {
        const errors: string[] = [];
        for (const rb of repoBranches) {
          if (rb.branch === trimmed) continue;
          try {
            await window.api.renameBranch({
              projectId,
              worktreeId: worktree.id,
              newBranchName: trimmed,
              repoId: rb.repoId,
            });
            useProjectsStore
              .getState()
              .updateBranchName(projectId, worktree.id, trimmed, rb.repoId);
          } catch (err: unknown) {
            errors.push(
              `${rb.repoName}: ${err instanceof Error ? err.message : 'Failed'}`,
            );
          }
        }
        if (errors.length > 0) {
          setRenameError(errors.join('; '));
        } else {
          cancelRename();
        }
        void useProjectsStore.getState().refreshDiffStats();
      } finally {
        setRenameLoading(false);
      }
    },
    [
      renameValue,
      projectId,
      worktree.id,
      repoBranches,
      renameConfirmRemote,
      cancelRename,
    ],
  );

  const handleViewPipeline = useCallback(
    (pipeline: PipelineInfo): void => {
      onClose();

      void (async (): Promise<void> => {
        let pipelineCwd: string | undefined;
        try {
          pipelineCwd = await window.api.getWorktreePath({
            projectId,
            worktreeId: worktree.id,
          });
        } catch {
          // Fall through — editor can still attempt to open without cwd
        }

        const { openPipelineEdit } = useNavigationStore.getState();
        openPipelineEdit({
          pipelineId: pipeline.id,
          cwd: pipelineCwd,
          filePath: pipeline.filePath,
        });
      })();
    },
    [projectId, worktree.id, onClose],
  );

  const displayBaseBranch = useMemo(
    (): string | null =>
      resolveDisplayedBaseBranch({
        isMultiRepo,
        repoBranches,
        baseBranch,
        trackedBaseBranch: worktree.trackedBaseBranch,
      }),
    [baseBranch, isMultiRepo, repoBranches, worktree.trackedBaseBranch],
  );

  const displayBaseBranchProvenance = useMemo((): {
    label: 'local' | 'remote';
    className: string;
  } | null => {
    if (isMultiRepo) {
      return getSharedBaseBranchProvenance(repoBranches, displayBaseBranch);
    }
    return getBaseBranchProvenance({
      existsLocally: baseBranchExistsLocally,
      existsInRemote: baseBranchExistsInRemote,
    });
  }, [
    baseBranchExistsLocally,
    baseBranchExistsInRemote,
    displayBaseBranch,
    isMultiRepo,
    repoBranches,
  ]);

  const missingRepos = useMemo(() => {
    if (!isMultiRepo || !configRepos || !repoBranches) return [];
    const onDiskRepoIds = new Set(repoBranches.map((rb) => rb.repoId));
    return configRepos.filter((r) => !onDiskRepoIds.has(r.id));
  }, [isMultiRepo, configRepos, repoBranches]);

  const staleRepos = useMemo(() => {
    if (!isMultiRepo || !configRepos) return [];
    const configRepoIds = new Set(configRepos.map((r) => r.id));
    return (repoBranches ?? []).filter(
      (rb) =>
        rb.repoId !== WORKSPACE_ROOT_REPO_ID && !configRepoIds.has(rb.repoId),
    );
  }, [isMultiRepo, configRepos, repoBranches]);

  // Per-repo health problems on repos that are present on disk. Missing-repo
  // issues are already rendered via `missingRepos`, so they're excluded here.
  const brokenRepoIssues = useMemo(() => {
    if (!isMultiRepo) return [];
    return (worktree.healthIssue?.repoIssues ?? []).filter(
      (issue) => issue.code !== 'missing-repository',
    );
  }, [isMultiRepo, worktree.healthIssue]);
  const brokenRepoIds = useMemo(
    () => new Set(brokenRepoIssues.map((issue) => issue.repoId)),
    [brokenRepoIssues],
  );

  if (!open) return null;

  const handleClose = (): void => {
    onClose();
    cancelRename();
  };

  const handleAddRepo = async (repoId: string): Promise<void> => {
    setAddingRepoId(repoId);
    try {
      await onAddRepoToWorktree?.(worktree.id, repoId);
    } catch {
      // Error handled upstream
    } finally {
      setAddingRepoId(null);
    }
  };

  const handleRemoveRepo = async (repoId: string): Promise<void> => {
    setRemovingRepoId(repoId);
    try {
      await onRemoveRepoFromWorktree?.(worktree.id, repoId);
    } catch {
      // Error handled upstream
    } finally {
      setRemovingRepoId(null);
    }
  };

  const labelField = (
    <LabelField
      label={worktree.label}
      fallback={labelFallback ?? worktree.branchName}
      placeholder={labelFallback ?? worktree.branchName}
      startInEdit={labelEditRequested}
      onEditConsumed={() => setLabelEditRequested(false)}
      onSubmit={(label) => setWorktreeLabel(projectId, worktree.id, label)}
    />
  );
  const branchSetupNotice = branchMutationsDisabled ? (
    <Surface variant="group" data-testid="branch-setup-pending-notice">
      <div className="px-3 py-2">
        <p className="text-xs font-medium fg-primary">Setting up worktree</p>
        <p className="mt-0.5 text-xs fg-secondary">
          Branch changes will be available when setup finishes.
        </p>
      </div>
    </Surface>
  ) : null;

  if (!isMultiRepo) {
    const titleId = `branch-info-${worktree.id}`;
    return (
      <BranchInfoModalFrame
        titleId={titleId}
        title="Branch info"
        maxWidth="md"
        escapeFirstClosesRename={renamingBranch !== null}
        onCancelRename={cancelRename}
        onClose={handleClose}
      >
        <div>
          <BranchInfoTabs
            active={effectiveBranchInfoTab}
            onChange={setBranchInfoTab}
            codeGraphEnabled={codeGraphExperimentEnabled}
          />
        </div>
        {effectiveBranchInfoTab === 'pipelines' && (
          <ProjectPipelineList
            pipelines={projectPipelines}
            loading={pipelinesLoading}
            onView={handleViewPipeline}
          />
        )}
        {effectiveBranchInfoTab === 'code-graph' && codeGraphPanel}
        {effectiveBranchInfoTab === 'details' && (
          <Stack gap="inline">
            <div>{labelField}</div>
            {branchSetupNotice}
            {worktree.healthIssue?.status === 'broken' && (
              <WorktreeHealthAlert
                issue={worktree.healthIssue}
                retrying={healthRetrying}
                retryError={healthRetryError}
                onRetry={handleRetryHealthCheck}
              />
            )}
            <DirectoryFact
              worktreeDirectory={worktreeDirectory}
              worktreeDirectoryStatus={worktreeDirectoryStatus}
            />
            {renamingBranch === 'single' ? (
              <BranchRenameForm
                inputRef={renameInputRef}
                value={renameValue}
                onChange={(next) => {
                  setRenameValue(next);
                  setRenameError(null);
                  setRenameConfirmRemote(false);
                }}
                loading={renameLoading}
                error={renameError}
                submitLabel="Save"
                ariaLabel="New branch name"
                onSubmit={() =>
                  void handleRenameBranch(
                    undefined,
                    worktree.branchName,
                    hasBranchBeenPushed ?? false,
                  )
                }
                onCancel={cancelRename}
                confirmRemote={renameConfirmRemote}
                warningMessage="This branch has already been pushed to remote. Renaming will only change the local branch name — the old remote branch and any associated PRs will still exist."
                warningConfirmLabel="Rename anyway"
                onWarningConfirm={() => {
                  setRenameConfirmRemote(true);
                  void handleRenameBranch(
                    undefined,
                    worktree.branchName,
                    false,
                  );
                }}
              />
            ) : (
              <Stack gap="inline">
                <Surface variant="outline">
                  <div className="flex items-center justify-between gap-2 px-3 py-2">
                    <BranchActionButtons
                      branch={worktree.branchName}
                      copyKey="single"
                      copiedBranch={copiedBranch}
                      disabled={branchMutationsDisabled}
                      onSwitchBranchClick={() =>
                        setBranchPickerOpen(
                          branchPickerOpen === 'single' ? null : 'single',
                        )
                      }
                      onRenameClick={() =>
                        startRename('single', worktree.branchName)
                      }
                      onCopyClick={(e) =>
                        handleCopyBranch('single', worktree.branchName, e)
                      }
                    />
                  </div>
                </Surface>
                <Surface variant="outline">
                  <div className="px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-3xs font-medium fg-secondary">
                        Base branch
                      </span>
                      {displayBaseBranchProvenance && (
                        <span
                          className={`text-3xs ${displayBaseBranchProvenance.className}`}
                          data-testid="base-branch-provenance-badge"
                        >
                          {displayBaseBranchProvenance.label}
                        </span>
                      )}
                    </div>
                    <div>
                      <BaseBranchDropdown
                        projectId={projectId}
                        worktreeId={worktree.id}
                        currentValue={displayBaseBranch}
                        disabled={branchMutationsDisabled}
                        onChange={(branchName, presence) => {
                          void (async (): Promise<void> => {
                            await useProjectsStore
                              .getState()
                              .setTrackedBaseBranch(
                                projectId,
                                worktree.id,
                                branchName,
                                undefined,
                                presence,
                              );
                            await refreshWorktreeActivity(
                              projectId,
                              worktree.id,
                            );
                          })();
                        }}
                      />
                    </div>
                  </div>
                </Surface>
                {branchPickerOpen === 'single' && (
                  <div>
                    <BranchPicker
                      projectId={projectId}
                      worktreeId={worktree.id}
                      baseBranch={displayBaseBranch}
                      onBranchSwitched={() => void handleBranchSwitched()}
                      onClose={() => setBranchPickerOpen(null)}
                    />
                  </div>
                )}
              </Stack>
            )}
          </Stack>
        )}
      </BranchInfoModalFrame>
    );
  }

  // Multi-repo modal
  const titleId = `repo-branches-${worktree.id}`;
  const renameAllAction =
    renamingBranch !== 'all' ? (
      <Tooltip label="Rename all branches">
        <Button
          variant="ghost"
          size="compact"
          iconOnly
          disabled={branchMutationsDisabled}
          onClick={() => {
            cancelRename();
            startRename(
              'all',
              repoBranches && repoBranches.length > 0
                ? repoBranches[0].branch
                : worktree.branchName,
            );
          }}
          aria-label="Rename all branches"
        >
          <AppCatalogPencilIcon size={14} />
        </Button>
      </Tooltip>
    ) : undefined;

  return (
    <BranchInfoModalFrame
      titleId={titleId}
      title="Repo branches"
      maxWidth="xl"
      headerActions={renameAllAction}
      escapeFirstClosesRename={renamingBranch !== null}
      onCancelRename={cancelRename}
      onClose={handleClose}
    >
      <div>
        <BranchInfoTabs
          active={effectiveBranchInfoTab}
          onChange={setBranchInfoTab}
          codeGraphEnabled={codeGraphExperimentEnabled}
        />
      </div>
      {effectiveBranchInfoTab === 'pipelines' && (
        <ProjectPipelineList
          pipelines={projectPipelines}
          loading={pipelinesLoading}
          onView={handleViewPipeline}
        />
      )}
      {effectiveBranchInfoTab === 'code-graph' && codeGraphPanel}
      {effectiveBranchInfoTab === 'details' && (
        <Stack gap="item">
          <Stack gap="inline">
            <div>{labelField}</div>
            {branchSetupNotice}
            {worktree.healthIssue?.status === 'broken' && (
              <WorktreeHealthAlert
                issue={worktree.healthIssue}
                retrying={healthRetrying}
                retryError={healthRetryError}
                onRetry={handleRetryHealthCheck}
              />
            )}
          </Stack>
          <DirectoryFact
            worktreeDirectory={worktreeDirectory}
            worktreeDirectoryStatus={worktreeDirectoryStatus}
          />
          {renamingBranch === 'all' && (
            <div>
              <BranchRenameForm
                inputRef={renameInputRef}
                value={renameValue}
                onChange={(next) => {
                  setRenameValue(next);
                  setRenameError(null);
                  setRenameConfirmRemote(false);
                }}
                loading={renameLoading}
                error={renameError}
                submitLabel="Rename all"
                ariaLabel="New branch name for all repos"
                onSubmit={() => {
                  const anyPushed =
                    repoBranches?.some((rb) => rb.hasBranchBeenPushed) ?? false;
                  void handleRenameAll(anyPushed);
                }}
                onCancel={cancelRename}
                confirmRemote={renameConfirmRemote}
                warningMessage="One or more branches have already been pushed to remote. Renaming will only change local branch names — the old remote branches and any associated PRs will still exist."
                warningConfirmLabel="Rename all anyway"
                onWarningConfirm={() => {
                  setRenameConfirmRemote(true);
                  void handleRenameAll(false);
                }}
              />
            </div>
          )}
          <div className="flex flex-col max-h-[60vh] overflow-y-auto gap-2 [&>*]:shrink-0">
            {/* Missing repos — in config but not on disk */}
            {missingRepos.map((repo) => (
              <Notice
                key={repo.id}
                intent="attention"
                role="none"
                title={repo.name}
                actions={
                  <NoticeButton
                    variant="primary"
                    disabled={addingRepoId === repo.id}
                    onClick={async (e) => {
                      e.stopPropagation();
                      await handleAddRepo(repo.id);
                    }}
                  >
                    {addingRepoId === repo.id ? 'Adding…' : 'Add'}
                  </NoticeButton>
                }
              >
                Not in worktree
              </Notice>
            ))}

            {/* Stale repos — on disk but removed from config */}
            {staleRepos.map((rb) => (
              <Notice
                key={rb.repoId}
                intent="attention"
                role="none"
                title={rb.repoName}
                actions={
                  <NoticeButton
                    disabled={removingRepoId === rb.repoId}
                    onClick={async (e) => {
                      e.stopPropagation();
                      await handleRemoveRepo(rb.repoId);
                    }}
                  >
                    {removingRepoId === rb.repoId ? 'Removing…' : 'Remove'}
                  </NoticeButton>
                }
              >
                Removed from project
              </Notice>
            ))}

            {/* Broken repos — present on disk but failed health checks */}
            {brokenRepoIssues.map((issue) => (
              <Notice
                key={issue.repoId}
                intent="attention"
                role="none"
                title={`${issue.repoName}: branch info unavailable`}
                detail={
                  issue.gitError ? (
                    <span
                      className={`${POSTHOG_REPLAY_BLOCK_CLASS} whitespace-pre-wrap break-words font-mono text-2xs`}
                    >
                      {issue.gitError}
                    </span>
                  ) : undefined
                }
              >
                {issue.message}
              </Notice>
            ))}

            {/* Normal repos — exist both in config and on disk */}
            {repoBranches && repoBranches.length > 0
              ? repoBranches
                  .filter(
                    (rb) =>
                      !staleRepos.some((s) => s.repoId === rb.repoId) &&
                      !brokenRepoIds.has(rb.repoId),
                  )
                  .map((rb) => {
                    const isRenamingThis = renamingBranch === rb.repoId;
                    const pickerOpen = branchPickerOpen === rb.repoId;
                    return (
                      <RepoBranchRow
                        key={rb.repoId}
                        rb={rb}
                        isRenamingThis={isRenamingThis}
                        pickerOpen={pickerOpen}
                        copiedBranch={copiedBranch}
                        branchMutationsDisabled={branchMutationsDisabled}
                        projectId={projectId}
                        worktreeId={worktree.id}
                        renameInputRef={renameInputRef}
                        renameValue={renameValue}
                        renameError={renameError}
                        renameLoading={renameLoading}
                        renameConfirmRemote={renameConfirmRemote}
                        onRenameChange={(next) => {
                          setRenameValue(next);
                          setRenameError(null);
                          setRenameConfirmRemote(false);
                        }}
                        onRenameSubmit={() =>
                          void handleRenameBranch(
                            rb.repoId,
                            rb.branch,
                            rb.hasBranchBeenPushed ?? false,
                          )
                        }
                        onRenameCancel={cancelRename}
                        onRenameWarningConfirm={() => {
                          setRenameConfirmRemote(true);
                          void handleRenameBranch(rb.repoId, rb.branch, false);
                        }}
                        onSwitchBranchClick={() =>
                          setBranchPickerOpen(
                            branchPickerOpen === rb.repoId ? null : rb.repoId,
                          )
                        }
                        onRenameClick={() => startRename(rb.repoId, rb.branch)}
                        onCopyClick={(e) =>
                          handleCopyBranch(rb.repoId, rb.branch, e)
                        }
                        onBranchSwitched={() => void handleBranchSwitched()}
                        onBaseBranchChange={(branchName, presence) => {
                          void (async (): Promise<void> => {
                            await useProjectsStore
                              .getState()
                              .setTrackedBaseBranch(
                                projectId,
                                worktree.id,
                                branchName,
                                rb.repoId,
                                presence,
                              );
                            await refreshWorktreeActivity(
                              projectId,
                              worktree.id,
                            );
                          })();
                        }}
                        onClosePicker={() => setBranchPickerOpen(null)}
                      />
                    );
                  })
              : missingRepos.length === 0 &&
                staleRepos.length === 0 &&
                brokenRepoIssues.length === 0 && (
                  <EmptyState title="No branch information available yet." />
                )}
          </div>
        </Stack>
      )}
    </BranchInfoModalFrame>
  );
}
