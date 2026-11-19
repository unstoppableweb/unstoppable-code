import { ControlButton } from '@canopy/ui-shared/components';
import { WorktreeApplyControlSurface } from '@canopy/ui-shared/components';
import { Stack, Heading, Surface } from '@canopy/ui-shared/components';
import {
  Button,
  RichHoverTooltip,
  SegmentedControl,
  type SegmentedControlOption,
} from '@canopy/ui-shared/components';
import { useId, useRef, type JSX, type ReactNode } from 'react';
import {
  FloatingPickerMenu,
  PickerMenuOption,
  PickerMenuOptionCheck,
  PickerMenuOptionContent,
  PickerMenuOptionDescription,
  PickerMenuOptionLabel,
  PickerMenuOptionLeading,
  PickerTrigger,
  PickerTriggerChevron,
} from '@canopy/ui-shared';
import type { WorkspaceSettingsDataResponse } from '@canopy/desktop-shared/types';
import { CopyButton, LoadingSpinner } from '../shared';
import { ToggleField } from '../pipeline/shared/ToggleField';
import type {
  AddToWorktreeFeedback,
  AddToWorktreeTarget,
} from './worktree-settings-controls-state';
import { TeardownFailureDialog } from './TeardownFailureDialog';
import { TeardownFailedError } from '@/stores/projectsStore';
import { brandText } from '@/lib/brand';
import {
  BranchIcon,
  RocketLaunchIcon,
  Link as AppCatalogLink,
  QuestionMarkIcon as AppCatalogQuestionMarkIcon,
  ChevronDownMediumIcon as AppCatalogChevronDownMediumIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { workspaceHealthIssueClassName } from './workspace-health-styles';

export type SettingsScope = 'source' | 'local';

export const SCRIPT_SETTINGS_ICON: ReactNode = <RocketLaunchIcon size="sm" />;

export const HOOK_SETTINGS_ICON: ReactNode = (
  <AppCatalogLink width="14" height="14" />
);

const SOURCE_LOCAL_OPTIONS: readonly SegmentedControlOption<SettingsScope>[] = [
  { value: 'source', label: 'Source controlled' },
  { value: 'local', label: 'Local override' },
];

interface SourceLocalToggleProps {
  /** Active mode — drives which segment renders with the active background. */
  mode: SettingsScope;
  onChange: (next: SettingsScope) => void;
  /** Rendered after the toggle on the same row, such as a one-line hint. */
  trailing?: ReactNode;
}

/**
 * Segmented "Source controlled / Local override" toggle. Used four times across
 * the project- and workspace-settings modals — twice each on the Scripts and
 * Hooks tabs. Strings are preserved verbatim per the cleanup plan.
 */
export function SourceLocalToggle({
  mode,
  onChange,
  trailing,
}: SourceLocalToggleProps): JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <SegmentedControl<SettingsScope>
        label="Settings source"
        value={mode}
        width="content"
        options={SOURCE_LOCAL_OPTIONS}
        onChange={onChange}
      />
      {trailing}
    </div>
  );
}

/**
 * Help text for the worktree dropdown in both the project- and
 * workspace-settings modals, shown on hover or focus of the help icon.
 */
const SETTINGS_HELP_CONTENT: ReactNode = (
  <Stack gap="inline">
    <p className="text-xs fg-primary">
      Project configuration can be source controlled or overridden locally.
      Local overrides always take priority.
    </p>
    <p className="text-xs fg-secondary">
      Select a worktree to view and edit the configuration present in that
      worktree. The default branch is used as a reference only and any source
      controlled edits must be applied via a worktree.
    </p>
  </Stack>
);

interface SaveLocalButtonProps {
  /** Disabled while a save IPC is in-flight or while a worktree apply is
   * happening. Mirrors the original `isSaving || isApplyingToWorktree` guards
   * in both modals so behavior stays identical. */
  disabled: boolean;
  /** When true the button label switches to `Saving…`. */
  isSaving: boolean;
  onClick: () => void;
}

/**
 * Modal-footer "Save Local" button. Identical between the project- and
 * workspace-settings modals — copy ("Save Local" / "Saving...") is preserved
 * verbatim.
 */
export function SaveLocalButton({
  disabled,
  isSaving,
  onClick,
}: SaveLocalButtonProps): JSX.Element {
  return (
    <Button
      variant="primary"
      size="compact"
      onClick={onClick}
      disabled={disabled}
    >
      {isSaving ? 'Saving…' : 'Save local'}
    </Button>
  );
}

export {
  SettingsDangerConfirmBlock,
  SettingsTabBar,
} from '@canopy/ui-shared/components';
export type {
  SettingsDangerConfirmBlockProps,
  SettingsTab,
  SettingsTabBarProps,
} from '@canopy/ui-shared/components';

interface DriftWorktreeInfo {
  id: string;
  branchName: string;
}

interface WorkspaceHealthIssuesBlockProps {
  /** Health response. Block renders nothing if absent or has no drift issues. */
  healthData: WorkspaceSettingsDataResponse | null;
  /** Drift-targeted worktree (if any) — surfaces id/branch in the header. */
  driftWorktree?: DriftWorktreeInfo | undefined;
}

/**
 * Workspace-health drift card + per-issue list shared by the project- and
 * workspace-settings modals. Strings (`Project health`, `Blocking issue`,
 * `Warning`, …) and class names match the original inline JSX exactly so the
 * card renders identically in both modals.
 */
export function WorkspaceHealthIssuesBlock({
  healthData,
  driftWorktree,
}: WorkspaceHealthIssuesBlockProps): JSX.Element | null {
  if (!healthData || healthData.driftIssues.length === 0) {
    return null;
  }
  return (
    <>
      <Surface variant="group" padding="default">
        <div className="flex flex-col gap-2 text-s">
          <Stack gap="item">
            <Stack gap="tight">
              <div className="font-medium fg-primary">Project health</div>
              <div className="text-xs fg-secondary">
                {brandText.appName} compares this project&apos;s tracked state
                against the evaluated <code>canopy.json</code>.
              </div>
            </Stack>
            {driftWorktree && (
              <div className="text-xs fg-secondary">
                Worktree{' '}
                <span className="font-medium fg-primary">
                  {driftWorktree.id}
                </span>{' '}
                · Branch{' '}
                <span className="font-medium fg-primary">
                  {driftWorktree.branchName}
                </span>
              </div>
            )}
          </Stack>
          {healthData.driftTargetPath && (
            <div className="break-all text-xs fg-secondary">
              {healthData.driftTargetPath}
            </div>
          )}
        </div>
      </Surface>
      <Stack gap="inline">
        {healthData.driftIssues.map((issue) => (
          <Surface
            variant="outline"
            key={`${issue.code}-${issue.repoId ?? 'workspace'}`}
          >
            <div
              className={`flex flex-col gap-1 px-3 py-2 text-xs ${workspaceHealthIssueClassName(issue.blocking)}`}
            >
              <div className="font-medium">
                {issue.blocking ? 'Blocking issue' : 'Warning'}
              </div>
              <div>{issue.message}</div>
            </div>
          </Surface>
        ))}
      </Stack>
    </>
  );
}

interface SourceWorktreeOption {
  id: string;
  branchName: string;
}

interface SourceWorktreePickerProps {
  /** Active selection — `undefined` represents the default branch. */
  selectedWorktreeId: string | undefined;
  onChange: (next: string | undefined) => void;
  /** Worktrees available in the listbox, in display order. */
  worktrees: ReadonlyArray<SourceWorktreeOption>;
  /** Open/closed state — owned by the parent so footer-level dropdowns can
   * collaborate (e.g. `Apply to existing worktree` chooser elsewhere). */
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /** DOM id for the help tooltip attached to the adjacent help icon. */
  helpTooltipId: string;
}

/**
 * Footer worktree/default-branch dropdown + help tooltip used in both
 * settings modals. The button label collapses to either the selected
 * worktree's branch name (or id, as a fallback) or the literal `Default
 * branch` when no worktree is selected, matching the original behavior.
 */
export function SourceWorktreePicker({
  selectedWorktreeId,
  onChange,
  worktrees,
  open,
  onOpenChange,
  helpTooltipId,
}: SourceWorktreePickerProps): JSX.Element {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const setOpen = (next: boolean | ((prev: boolean) => boolean)): void => {
    onOpenChange(typeof next === 'function' ? next(open) : next);
  };

  const selected = selectedWorktreeId
    ? worktrees.find((wt) => wt.id === selectedWorktreeId)
    : undefined;
  return (
    <div className="flex items-center gap-2">
      <div className="relative">
        <PickerTrigger
          ref={anchorRef}
          onClick={() => onOpenChange(!open)}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          data-testid="source-worktree-picker-trigger"
          variant="field"
          className="max-w-72"
        >
          <BranchIcon size="sm" className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {selectedWorktreeId
              ? (selected?.branchName ?? selectedWorktreeId)
              : 'Default branch'}
          </span>
          <PickerTriggerChevron open={open} />
        </PickerTrigger>
        <FloatingPickerMenu
          id={menuId}
          open={open}
          onOpenChange={setOpen}
          anchorRef={anchorRef}
          placement="top-left"
          heightLimit={320}
          interaction="listbox"
          role="listbox"
          aria-label="Source worktree options"
          data-testid="source-worktree-picker-menu"
        >
          <PickerMenuOption
            role="option"
            aria-selected={!selectedWorktreeId}
            data-testid="source-worktree-picker-default-option"
            onClick={() => {
              onChange(undefined);
              onOpenChange(false);
            }}
            selected={!selectedWorktreeId}
          >
            <PickerMenuOptionLeading>
              <BranchIcon size="md" />
            </PickerMenuOptionLeading>
            <PickerMenuOptionContent>
              <PickerMenuOptionLabel>Default branch</PickerMenuOptionLabel>
            </PickerMenuOptionContent>
            <PickerMenuOptionCheck selected={!selectedWorktreeId} />
          </PickerMenuOption>
          {worktrees.map((worktree) => (
            <PickerMenuOption
              key={worktree.id}
              role="option"
              aria-selected={selectedWorktreeId === worktree.id}
              data-testid={`source-worktree-picker-option-${worktree.id}`}
              onClick={() => {
                onChange(worktree.id);
                onOpenChange(false);
              }}
              selected={selectedWorktreeId === worktree.id}
            >
              <PickerMenuOptionLeading>
                <BranchIcon size="md" />
              </PickerMenuOptionLeading>
              <PickerMenuOptionContent>
                <PickerMenuOptionLabel>
                  {worktree.branchName}
                </PickerMenuOptionLabel>
                <PickerMenuOptionDescription>
                  {worktree.id}
                </PickerMenuOptionDescription>
              </PickerMenuOptionContent>
              <PickerMenuOptionCheck
                selected={selectedWorktreeId === worktree.id}
              />
            </PickerMenuOption>
          ))}
        </FloatingPickerMenu>
      </div>
      <RichHoverTooltip
        id={helpTooltipId}
        content={SETTINGS_HELP_CONTENT}
        surfacePadding="card"
        surfaceClassName="w-72"
      >
        <Button
          variant="ghost"
          size="compact"
          iconOnly
          aria-label="Project configuration help"
        >
          <AppCatalogQuestionMarkIcon size="sm" />
        </Button>
      </RichHoverTooltip>
    </div>
  );
}

interface AddToWorktreeActionControlsProps {
  show: boolean;
  sourceInspectWorktreeId: string | undefined;
  worktrees: ReadonlyArray<SourceWorktreeOption>;
  feedback: AddToWorktreeFeedback;
  buttonLabel: string;
  disabled: boolean;
  existingDropdownOpen: boolean;
  onExistingDropdownOpenChange: (next: boolean) => void;
  onAddToWorktree: (target: AddToWorktreeTarget) => void;
}

export function AddToWorktreeActionControls({
  show,
  sourceInspectWorktreeId,
  worktrees,
  feedback,
  buttonLabel,
  disabled,
  existingDropdownOpen,
  onExistingDropdownOpenChange,
  onAddToWorktree,
}: AddToWorktreeActionControlsProps): JSX.Element | null {
  const existingTriggerRef = useRef<HTMLButtonElement>(null);

  if (!show) {
    return null;
  }

  const canChooseExisting = !sourceInspectWorktreeId && worktrees.length > 0;

  return (
    <div className="relative">
      <WorktreeApplyControlSurface>
        <ControlButton
          type="button"
          onClick={() =>
            onAddToWorktree(
              sourceInspectWorktreeId
                ? {
                    mode: 'existing',
                    worktreeId: sourceInspectWorktreeId,
                  }
                : { mode: 'new' },
            )
          }
          disabled={disabled}
          presentation="worktree-apply"
          appearance={Boolean(sourceInspectWorktreeId)}
        >
          {feedback.phase === 'applying' && <LoadingSpinner />}
          {buttonLabel}
        </ControlButton>
        {canChooseExisting && (
          <ControlButton
            ref={existingTriggerRef}
            type="button"
            onClick={() => onExistingDropdownOpenChange(!existingDropdownOpen)}
            disabled={disabled}
            aria-label="Select an existing worktree"
            aria-haspopup="listbox"
            aria-expanded={existingDropdownOpen}
            data-testid="add-to-existing-worktree-trigger"
            presentation="worktree-apply-menu"
          >
            <AppCatalogChevronDownMediumIcon size="sm" />
          </ControlButton>
        )}
      </WorktreeApplyControlSurface>
      {canChooseExisting && (
        <FloatingPickerMenu
          open={existingDropdownOpen}
          onOpenChange={onExistingDropdownOpenChange}
          anchorRef={existingTriggerRef}
          placement="top-right"
          heightLimit={256}
          interaction="listbox"
          role="listbox"
          aria-label="Existing worktrees"
          data-testid="add-to-existing-worktree-menu"
        >
          {worktrees.map((wt) => (
            <PickerMenuOption
              key={wt.id}
              role="option"
              aria-selected={false}
              data-testid={`add-to-existing-worktree-option-${wt.id}`}
              onClick={() => {
                onExistingDropdownOpenChange(false);
                onAddToWorktree({
                  mode: 'existing',
                  worktreeId: wt.id,
                });
              }}
            >
              <PickerMenuOptionLeading>
                <BranchIcon size="md" />
              </PickerMenuOptionLeading>
              <PickerMenuOptionContent>
                <PickerMenuOptionLabel>{wt.branchName}</PickerMenuOptionLabel>
                <PickerMenuOptionDescription>
                  {wt.id}
                </PickerMenuOptionDescription>
              </PickerMenuOptionContent>
              <PickerMenuOptionCheck selected={false} />
            </PickerMenuOption>
          ))}
        </FloatingPickerMenu>
      )}
    </div>
  );
}

interface SettingsDirectoryCardProps {
  /** Filesystem directory to display. Trailing slashes are stripped. */
  path: string;
}

/**
 * Bordered "Directory" card used in both the project- and workspace-settings
 * modals. Mirrors the inline JSX previously duplicated in each modal:
 * heading, copy-path button, and a right-to-left truncated path display so
 * long paths keep the trailing segment visible.
 */
export function SettingsDirectoryCard({
  path,
}: SettingsDirectoryCardProps): JSX.Element {
  const dirPath = path.replace(/\/+$/, '');
  return (
    <Surface variant="outline" gap="tight" padding="default">
      <div className="flex items-center justify-between gap-2">
        <Heading level={3} variant="title">
          Directory
        </Heading>
        <CopyButton
          value={dirPath}
          ariaLabel="Copy directory path"
          title="Copy directory path"
        />
      </div>
      <p
        className="truncate font-mono text-xs fg-secondary"
        style={{ direction: 'rtl', textAlign: 'left' }}
        title={dirPath}
      >
        {`\u200E${dirPath}`}
      </p>
    </Surface>
  );
}

interface AlwaysShowWorkspaceCardProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  workspaceKind?: 'code' | 'cowork';
}

/**
 * "Always show project" toggle card shared between the project- and
 * workspace-settings modals. Keeps the user-facing copy verbatim.
 */
export function AlwaysShowWorkspaceCard({
  checked,
  onChange,
  workspaceKind = 'code',
}: AlwaysShowWorkspaceCardProps): JSX.Element {
  return (
    <Surface variant="outline" padding="default">
      <div className="flex items-center justify-between">
        <Stack gap="tight">
          <Heading level={3} variant="title">
            Always show project
          </Heading>
          <p className="text-xs fg-secondary">
            Keep the project in the worktree panel even when there are no{' '}
            {workspaceKind === 'cowork' ? 'work entries' : 'active worktrees'}
          </p>
        </Stack>
        <ToggleField
          checked={checked}
          onChange={onChange}
          label="Always show project"
        />
      </div>
    </Surface>
  );
}

interface SettingsTeardownFailureDialogProps {
  /** Active error — when null nothing renders. */
  error: TeardownFailedError | null;
  isRetrying: boolean;
  archiveWorktree: (projectId: string, worktreeId: string) => Promise<void>;
  forceArchiveWorktree: (
    projectId: string,
    worktreeId: string,
  ) => Promise<void>;
  /** Caller-supplied delete handler (e.g. handleDelete /
   * handleDeleteWorkspace). Invoked after the worktree is archived. */
  onRetryDelete: () => Promise<void>;
  onRetryingChange: (retrying: boolean) => void;
  onErrorChange: (error: TeardownFailedError | null) => void;
  /** Shows any other failure, such as a source admission refusal (CAN-5333). */
  onFailure: (message: string) => void;
}

const DELETE_WORKTREE_FAILED = "Couldn't delete the worktree. Try again.";

/**
 * Wraps `TeardownFailureDialog` with the retry/without-teardown/cancel wiring previously
 * duplicated across the project- and workspace-settings modals. Behavior:
 * - Retry: marks `isRetrying`, clears the active error, archives the worktree,
 *   then invokes `onRetryDelete`. If archiving raises another
 *   `TeardownFailedError` the new error is surfaced via `onErrorChange`.
 * - Delete without teardown: clears the active error, archives the worktree
 *   without its teardown script, then invokes `onRetryDelete`.
 * - Cancel: clears the active error.
 * Any other failure goes to `onFailure`.
 */
export function SettingsTeardownFailureDialog({
  error,
  isRetrying,
  archiveWorktree,
  forceArchiveWorktree,
  onRetryDelete,
  onRetryingChange,
  onErrorChange,
  onFailure,
}: SettingsTeardownFailureDialogProps): JSX.Element | null {
  if (!error) {
    return null;
  }

  const reportFailure = (cause: unknown): void => {
    if (cause instanceof TeardownFailedError) {
      onErrorChange(cause);
      return;
    }
    onFailure(
      cause instanceof Error && cause.message.trim() !== ''
        ? cause.message
        : DELETE_WORKTREE_FAILED,
    );
  };

  return (
    <TeardownFailureDialog
      error={error}
      isRetrying={isRetrying}
      onRetry={(): void => {
        onRetryingChange(true);
        onErrorChange(null);
        void archiveWorktree(error.projectId, error.worktreeId)
          .then(() => onRetryDelete())
          .catch(reportFailure)
          .finally(() => onRetryingChange(false));
      }}
      onSkipTeardown={(): void => {
        onErrorChange(null);
        void forceArchiveWorktree(error.projectId, error.worktreeId)
          .then(() => onRetryDelete())
          .catch(reportFailure);
      }}
      onCancel={(): void => onErrorChange(null)}
    />
  );
}
