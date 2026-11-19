'use client';

import type { JSX } from 'react';
import type { WorktreeDiscardDescription } from '@canopy/protocol/remote-control/shell/worktree-discard';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';
import {
  projectDeletionDiscardCopy,
  type ProjectDeletionDiscardItemProgress,
} from '../lib/project-deletion-discard-copy';
import { Button } from './Button';
import { ConfirmDialog } from './ConfirmDialog';
import { WorktreeDiscardPathList } from './WorktreeDiscardDialog';

export const PROJECT_DELETION_DISCARD_DIALOG_TEST_ID =
  'project-deletion-discard-dialog';

export interface ProjectDeletionDiscardDialogItem {
  readonly worktreeId: string;
  /** Absent for an interrupted discard whose row is gone. */
  readonly worktreeName?: string;
  readonly description: WorktreeDiscardDescription;
  readonly progress: ProjectDeletionDiscardItemProgress;
}

export interface ProjectDeletionDiscardDialogProps {
  readonly projectName: string;
  readonly pendingRecovery?: boolean;
  readonly items: readonly ProjectDeletionDiscardDialogItem[];
  readonly interruptedDeletion: boolean;
  readonly earlierDiscarded: readonly string[];
  readonly busy: boolean;
  /** Why the run stopped; the dialog stays open. */
  readonly errorMessage: string | null;
  readonly onConfirm: () => void;
  /** Discards one row only; the confirmation stays open with the rest. */
  readonly onDiscardItem?: (worktreeId: string) => void;
  readonly onCancel: () => void;
}

/** A row the run hasn't finished, so it can still be discarded on its own. */
function discardable(progress: ProjectDeletionDiscardItemProgress): boolean {
  return progress === 'pending' || progress === 'stopped';
}

/**
 * CAN-5337: one confirmation for every item that keeps a project's deletion
 * from finishing, each worktree named with the paths its discard deletes and
 * its progress once the run starts. Design deviation, as for the worktree
 * discard (docs/design/feedback.md "ConfirmDialog"): the message slot holds
 * several sentences and a bounded list per worktree, because every deleted
 * path must be named before the one confirmation.
 */
export function ProjectDeletionDiscardDialog({
  projectName,
  pendingRecovery = false,
  items,
  interruptedDeletion,
  earlierDiscarded,
  busy,
  errorMessage,
  onConfirm,
  onDiscardItem,
  onCancel,
}: ProjectDeletionDiscardDialogProps): JSX.Element {
  const copy = projectDeletionDiscardCopy({
    items: items.map((item) => ({
      name: item.worktreeName ?? item.worktreeId,
      description: item.description,
      progress: item.progress,
    })),
    interruptedDeletion,
    earlierDiscarded,
    pendingRecovery,
  });
  const testId = PROJECT_DELETION_DISCARD_DIALOG_TEST_ID;
  return (
    <ConfirmDialog
      dataTestId={testId}
      confirmTestId={`${testId}-confirm`}
      cancelTestId={`${testId}-cancel`}
      title={
        <>
          Delete project{' '}
          <span className={REPLAY_MASK_CLASS}>“{projectName}”</span>?
        </>
      }
      message={
        <div className="flex flex-col gap-2">
          <p>{copy.lead}</p>
          {copy.items.length > 0 ? (
            <ul
              className="flex max-h-72 flex-col gap-3 overflow-y-auto"
              data-testid={`${testId}-items`}
            >
              {copy.items.map((item, index) => (
                <li
                  key={items[index].worktreeId}
                  className="flex flex-col gap-1"
                  data-testid={`${testId}-item`}
                >
                  <span className="flex items-baseline justify-between gap-2 text-s fg-primary">
                    <span className={REPLAY_MASK_CLASS}>{item.name}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      {item.status ? (
                        <span
                          className="text-xs fg-tertiary"
                          data-testid={`${testId}-item-status`}
                        >
                          {item.status}
                        </span>
                      ) : null}
                      {onDiscardItem &&
                      copy.discardItemLabel &&
                      discardable(items[index].progress) ? (
                        <Button
                          variant="secondary"
                          size="compact"
                          disabled={busy}
                          onClick={() => onDiscardItem(items[index].worktreeId)}
                          data-testid={`${testId}-item-discard`}
                        >
                          {copy.discardItemLabel}
                        </Button>
                      ) : null}
                    </span>
                  </span>
                  {item.paths.length > 0 ? (
                    <WorktreeDiscardPathList
                      rows={item.paths}
                      testId={`${testId}-paths`}
                    />
                  ) : null}
                  {item.emptyNote ? (
                    <span className="text-xs fg-secondary">
                      {item.emptyNote}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {copy.onlyCopyWarning ? <p>{copy.onlyCopyWarning}</p> : null}
          {copy.alsoDeleted ? <p>{copy.alsoDeleted}</p> : null}
          {copy.interruptedDeletion ? <p>{copy.interruptedDeletion}</p> : null}
          {copy.earlierDiscardedLead ? (
            <p data-testid={`${testId}-earlier`}>
              {copy.earlierDiscardedLead}{' '}
              <span className={REPLAY_MASK_CLASS}>
                {earlierDiscarded.join(', ')}
              </span>
            </p>
          ) : null}
          {copy.items.length > 0 ? (
            <p data-testid={`${testId}-disconnected`}>
              {copy.disconnectedWarning}
            </p>
          ) : null}
        </div>
      }
      confirmLabel={copy.confirmLabel}
      busyLabel="Deleting…"
      busy={busy}
      destructive
      errorMessage={errorMessage}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
