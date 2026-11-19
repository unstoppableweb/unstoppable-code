'use client';

import { DialogActionFooter } from '@canopy/ui-shared/components';
import type { JSX } from 'react';
import {
  Button,
  DialogModal,
  RichHoverTooltip,
  ThinkingSpinner,
} from '@canopy/ui-shared/components';
import { WarningIcon } from '@canopy/ui-shared/icons/AppIcons';
import { Surface } from '@canopy/ui-shared/components';

/**
 * Base-branch drift (REG-3025, moved from the desktop `PrStatusBar`): the
 * worktree tracks one base branch while its pull request targets another.
 * The header shows a warning beside the base branch; clicking it asks to
 * align the worktree with the PR. Only the worktree's tracked base changes;
 * the PR is never modified.
 */
export interface BaseBranchDrift {
  readonly repoId: string;
  readonly repoName: string;
  readonly localBaseBranch: string;
  readonly prBaseBranch: string;
  readonly prNumber: number;
}

type BaseBranchDriftList = readonly BaseBranchDrift[];

interface BaseBranchDriftTooltipContentProps {
  readonly drifts: BaseBranchDriftList;
}

export function BaseBranchDriftTooltipContent({
  drifts,
}: BaseBranchDriftTooltipContentProps): JSX.Element {
  const singleDrift = drifts.length === 1 ? drifts[0] : null;
  return (
    <>
      <div className="pb-1 font-semibold fg-primary">Base branch drift</div>
      {singleDrift ? (
        <p className="fg-secondary">
          The locally tracked base branch{' '}
          <span className="font-mono fg-primary">
            {singleDrift.localBaseBranch}
          </span>{' '}
          does not match PR #{singleDrift.prNumber}, which targets{' '}
          <span className="font-mono fg-primary">
            {singleDrift.prBaseBranch}
          </span>
          .
        </p>
      ) : (
        <div className="flex flex-col gap-1.5 fg-secondary">
          <p>{drifts.length} repositories differ from their PR base:</p>
          <ul className="flex flex-col gap-1">
            {drifts.map((drift) => (
              <li key={drift.repoId}>
                <span className="font-medium fg-primary">{drift.repoName}</span>{' '}
                <span className="font-mono">{drift.localBaseBranch}</span>
                <span className="px-1 fg-quaternary">→</span>
                <span className="font-mono fg-primary">
                  {drift.prBaseBranch}
                </span>{' '}
                <span>(PR #{drift.prNumber})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="pt-1.5 fg-tertiary">Click to align with the PR.</p>
    </>
  );
}

interface AlignBaseBranchConfirmationProps {
  readonly drifts: BaseBranchDriftList;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
  /** The confirmed metadata update runs to completion before dismissal. */
  readonly pending?: boolean;
}

export function AlignBaseBranchConfirmation({
  drifts,
  onConfirm,
  onClose,
  pending = false,
}: AlignBaseBranchConfirmationProps): JSX.Element {
  return (
    <DialogModal
      inset="flush"
      onClose={onClose}
      title="Align base branch with PR?"
      maxWidth="sm"
      dataTestId="pr-status-base-branch-drift-modal"
      closeOnBackdrop={!pending}
      closeOnEscape={!pending}
      showCloseButton={!pending}
    >
      <div className="flex flex-col gap-3 p-6 text-s fg-primary">
        <p className="fg-secondary">
          Update the locally tracked base branch to match the open pull request?
          This changes the worktree metadata and does not modify the PR.
        </p>
        <Surface variant="group" size="small" padding="compact">
          <ul className="flex flex-col gap-1.5 text-xs">
            {drifts.map((drift) => (
              <li key={drift.repoId} className="min-w-0">
                {drifts.length > 1 && (
                  <span className="pr-1 font-semibold">{drift.repoName}:</span>
                )}
                <span className="font-mono fg-secondary">
                  {drift.localBaseBranch}
                </span>
                <span className="px-1.5 fg-quaternary">→</span>
                <span className="font-mono font-medium">
                  {drift.prBaseBranch}
                </span>
                <span className="pl-1 fg-tertiary">PR #{drift.prNumber}</span>
              </li>
            ))}
          </ul>
        </Surface>
      </div>
      <DialogActionFooter center padding="roomy">
        {!pending && (
          <Button size="compact" onClick={onClose}>
            Cancel
          </Button>
        )}
        <Button
          variant="primary"
          size="compact"
          data-testid="pr-status-base-branch-drift-confirm"
          onClick={onConfirm}
          disabled={pending}
          aria-busy={pending}
        >
          {pending && <ThinkingSpinner tone="emphasis" quiet />}
          {pending ? 'Updating base branch…' : 'Update base branch'}
        </Button>
      </DialogActionFooter>
    </DialogModal>
  );
}

/** The warning beside the base branch; opens the alignment question. */
export function BaseBranchDriftWarning({
  drifts,
  onAlign,
}: {
  readonly drifts: BaseBranchDriftList;
  readonly onAlign: () => void;
}): JSX.Element {
  return (
    <RichHoverTooltip
      dataTestId="pr-status-base-branch-drift-tooltip"
      surfaceClassName="min-w-60 max-w-90"
      surfacePadding="card"
      content={
        <div className="text-xs">
          <BaseBranchDriftTooltipContent drifts={drifts} />
        </div>
      }
    >
      <Button
        variant="secondary"
        size="sm"
        iconOnly
        data-testid="pr-status-base-branch-drift-warning"
        aria-label="Base branch differs from PR"
        onClick={onAlign}
        className="electron-no-drag"
      >
        <WarningIcon size={16} aria-hidden="true" />
      </Button>
    </RichHoverTooltip>
  );
}
