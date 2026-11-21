'use client';

import { Button } from './Button';
import { useState, type JSX } from 'react';
import { InfoIcon } from '../icons/AppIcons';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';
import { ConfirmDialog } from './ConfirmDialog';
import { RichHoverTooltip } from './RichHoverTooltip';
import {
  KeepLocalBranchToggle,
  DEFAULT_KEEP_LOCAL_BRANCH,
} from './KeepLocalBranchToggle';

/** The row a worktree removal confirmation names. */
export interface WorktreeRemovalDialogIdentity {
  readonly workspaceName: string;
  readonly worktreeName: string;
  readonly worktreeId: string;
  readonly branchName: string;
}

export interface WorktreeRemovalDialogProps {
  /**
   * The action, a verb and noun (`Delete worktree`). The title repeats it as
   * a question naming the worktree: `Delete worktree “owl”?`.
   */
  readonly confirmLabel: string;
  /** Delete takes the destructive role; Archive keeps everything. */
  readonly destructive: boolean;
  readonly identity: WorktreeRemovalDialogIdentity;
  /**
   * Local work the removal takes with it. `insertions`/`deletions` are shown
   * when the diff has line changes; an empty object still names the work.
   */
  readonly localChanges?: {
    readonly insertions?: number;
    readonly deletions?: number;
  };
  /** One-line retention outcome, such as how long the archive is kept. */
  readonly retentionSummary: string;
  /** The full retention explanation, shown from the info button. */
  readonly retentionDetail: string;
  /**
   * Who suggested the branch handling, such as an App Advisor request. Shown
   * under the switch; the user still decides.
   */
  readonly branchChoiceHint?: string | null;
  /**
   * The branch handling an App Advisor request asked for. It presets the
   * switch; without one, the local branch is kept.
   */
  readonly requestedDeleteBranch?: boolean;
  /** Removal cannot run right now; the action is disabled. */
  readonly disabled: boolean;
  /** Suffix for the automation ids on a pinned row copy. */
  readonly testIdSuffix?: string;
  readonly onCancel: () => void;
  readonly onConfirm: (deleteBranch: boolean) => void;
}

/**
 * Worktree removal confirmation in the shared confirmation shape: the
 * question naming the worktree, what goes with it, one switch for the local
 * Git branch, then Cancel and the action.
 */
export function WorktreeRemovalDialog({
  confirmLabel,
  destructive,
  identity,
  localChanges,
  retentionSummary,
  retentionDetail,
  branchChoiceHint,
  requestedDeleteBranch,
  disabled,
  testIdSuffix = '',
  onCancel,
  onConfirm,
}: WorktreeRemovalDialogProps): JSX.Element {
  const [keepBranch, setKeepBranch] = useState(
    requestedDeleteBranch === undefined
      ? DEFAULT_KEEP_LOCAL_BRANCH
      : !requestedDeleteBranch,
  );
  // A replacement request (another worktree, the other mode, or a different
  // requested branch handling) presets the switch again instead of keeping
  // the choice made for the previous request.
  const requestKey = `${identity.worktreeId}|${String(destructive)}|${String(requestedDeleteBranch)}`;
  const [presetFor, setPresetFor] = useState(requestKey);
  if (presetFor !== requestKey) {
    setPresetFor(requestKey);
    setKeepBranch(
      requestedDeleteBranch === undefined
        ? DEFAULT_KEEP_LOCAL_BRANCH
        : !requestedDeleteBranch,
    );
  }
  const automationId = (base: string): string => `${base}${testIdSuffix}`;
  const hasLineStats =
    localChanges !== undefined &&
    (localChanges.insertions ?? 0) + (localChanges.deletions ?? 0) > 0;
  return (
    // The dialog portals to <body>, but React still bubbles its clicks to the
    // row that opened it; stop them here so a backdrop click cannot also
    // select or open that row.
    <div className="contents" onClick={(event) => event.stopPropagation()}>
      <ConfirmDialog
        // User-authored names are masked in session replay.
        title={
          <>
            {confirmLabel} “
            <span className={REPLAY_MASK_CLASS}>{identity.worktreeName}</span>”?
          </>
        }
        message={
          <p data-testid={automationId('worktree-removal-summary')}>
            {localChanges && (
              <>
                Its local changes
                {hasLineStats && (
                  <>
                    {' ('}
                    <span className="tabular-nums">
                      <span className="fg-success">
                        +{localChanges.insertions ?? 0}
                      </span>{' '}
                      <span className="fg-destructive">
                        −{localChanges.deletions ?? 0}
                      </span>
                    </span>
                    {')'}
                  </>
                )}{' '}
                go with it.{' '}
              </>
            )}
            <span className="inline-flex max-w-full items-center gap-1 align-middle">
              <span className="min-w-0">{retentionSummary}</span>
              <RichHoverTooltip
                content={
                  <span className="block text-xs leading-snug fg-primary">
                    {retentionDetail}
                  </span>
                }
                surfaceClassName="w-72"
                showOnPress
                dataTestId={automationId('worktree-removal-retention-detail')}
                triggerWrapperClassName="inline-flex h-5 shrink-0 items-center align-middle"
              >
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label="About restoring this worktree"
                  data-testid={automationId('worktree-removal-retention-info')}
                >
                  <InfoIcon size={14} aria-hidden="true" />
                </Button>
              </RichHoverTooltip>
            </span>
          </p>
        }
        confirmLabel={confirmLabel}
        destructive={destructive}
        onConfirm={(): void => {
          if (disabled) return;
          onConfirm(!keepBranch);
        }}
        onCancel={onCancel}
        dataTestId={automationId('worktree-removal-dialog')}
        cancelTestId={automationId('worktree-removal-cancel')}
        // The action names what it will do with the branch, so automation that
        // asks for one outcome finds the button only while the switch says so.
        confirmTestId={automationId(
          keepBranch
            ? 'worktree-removal-preserve-branch'
            : 'worktree-removal-delete-branch',
        )}
        confirmDisabled={disabled}
      >
        <KeepLocalBranchToggle
          checked={keepBranch}
          onChange={setKeepBranch}
          dataTestId={automationId('worktree-removal-keep-branch')}
          noteTestId={automationId('worktree-removal-target-identity')}
        >
          {identity.branchName}
          {keepBranch ? ' stays in ' : ' is deleted from '}
          <span className={REPLAY_MASK_CLASS}>{identity.workspaceName}</span>.
          {branchChoiceHint ? ` ${branchChoiceHint}` : ''}
        </KeepLocalBranchToggle>
      </ConfirmDialog>
    </div>
  );
}
