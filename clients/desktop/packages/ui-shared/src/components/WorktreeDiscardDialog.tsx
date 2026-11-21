'use client';

import type { JSX } from 'react';
import type { WorktreeDiscardDescription } from '@canopy/protocol/remote-control/shell/worktree-discard';
import { REPLAY_BLOCK_CLASS, REPLAY_MASK_CLASS } from '../lib/replay-privacy';
import {
  worktreeDiscardCopy,
  type WorktreeDiscardPathRow,
} from '../lib/worktree-discard-copy';
import { ConfirmDialog, type ConfirmDialogErrorProps } from './ConfirmDialog';

export const WORKTREE_DISCARD_DIALOG_TEST_ID = 'worktree-discard-dialog';

/**
 * The paths a discard deletes, or the missing sources it names: a label above
 * each full path. Bounded with its own scroll so a multi-repo worktree's list
 * never pushes the actions off screen. Exported for project deletion (CAN-4995 E).
 */
export function WorktreeDiscardPathList({
  rows,
  testId,
}: {
  readonly rows: readonly WorktreeDiscardPathRow[];
  readonly testId: string;
}): JSX.Element {
  return (
    <ul
      className="flex max-h-40 flex-col gap-1.5 overflow-y-auto"
      data-testid={testId}
    >
      {rows.map((row) => (
        <li
          key={`${row.label}:${row.path}`}
          className="flex flex-col gap-0.5"
          data-testid={`${testId}-row`}
        >
          <span className="text-xs fg-tertiary">{row.label}</span>
          <span
            className={`${REPLAY_BLOCK_CLASS} text-xs font-mono break-all select-text fg-secondary`}
          >
            {row.path}
          </span>
          {row.details?.map((detail) => (
            <span
              key={detail}
              className={`${REPLAY_BLOCK_CLASS} text-xs fg-secondary`}
            >
              {detail}
            </span>
          ))}
        </li>
      ))}
    </ul>
  );
}

interface WorktreeDiscardDialogBaseProps {
  readonly worktreeName: string;
  readonly description: WorktreeDiscardDescription;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  /** Omitted when the ordinary removal isn't the way back: no Retry then. */
  readonly onRetry?: () => void;
  readonly onCancel: () => void;
}

/** `errorMessage` is why the last attempt didn't run; the dialog stays open. */
export type WorktreeDiscardDialogProps = WorktreeDiscardDialogBaseProps &
  ConfirmDialogErrorProps;

/**
 * CAN-5336: confirms the permanent discard of a worktree whose ordinary
 * removal can't finish. Design deviation, pending a design-system review
 * (docs/design/feedback.md "ConfirmDialog"): the message slot carries several
 * sentences and the path list, because every deleted path must be named, and
 * Retry takes the secondary action slot as the non-lossy alternative rather
 * than the other answer of a two-way choice.
 */
export function WorktreeDiscardDialog({
  worktreeName,
  description,
  busy,
  onConfirm,
  onRetry,
  onCancel,
  ...errorProps
}: WorktreeDiscardDialogProps): JSX.Element {
  const copy = worktreeDiscardCopy(description);
  return (
    <ConfirmDialog
      dataTestId={WORKTREE_DISCARD_DIALOG_TEST_ID}
      confirmTestId={`${WORKTREE_DISCARD_DIALOG_TEST_ID}-confirm`}
      cancelTestId={`${WORKTREE_DISCARD_DIALOG_TEST_ID}-cancel`}
      title={
        <>
          Discard worktree{' '}
          <span className={REPLAY_MASK_CLASS}>“{worktreeName}”</span>?
        </>
      }
      message={
        <div className="flex flex-col gap-2">
          <p>{copy.lead}</p>
          {copy.targets.length > 0 ? (
            <WorktreeDiscardPathList
              rows={copy.targets}
              testId={`${WORKTREE_DISCARD_DIALOG_TEST_ID}-targets`}
            />
          ) : null}
          {copy.onlyCopyWarning ? <p>{copy.onlyCopyWarning}</p> : null}
          {copy.missingSources.length > 0 ? (
            <WorktreeDiscardPathList
              rows={copy.missingSources}
              testId={`${WORKTREE_DISCARD_DIALOG_TEST_ID}-sources`}
            />
          ) : null}
          {copy.alsoDeleted ? <p>{copy.alsoDeleted}</p> : null}
          {copy.preserved ? <p>{copy.preserved}</p> : null}
          <p data-testid={`${WORKTREE_DISCARD_DIALOG_TEST_ID}-disconnected`}>
            {copy.disconnectedWarning}
          </p>
        </div>
      }
      confirmLabel={copy.confirmLabel}
      busyLabel="Discarding…"
      busy={busy}
      destructive
      confirmDisabled={description.status !== 'discardable'}
      {...errorProps}
      secondaryAction={
        onRetry
          ? {
              label: 'Try again',
              onSelect: onRetry,
              testId: `${WORKTREE_DISCARD_DIALOG_TEST_ID}-retry`,
            }
          : undefined
      }
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
