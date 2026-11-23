import type { JSX } from 'react';
import {
  ConfirmDialog,
  type ConfirmDialogErrorProps,
} from '@canopy/ui-shared/components';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

/**
 * A task's branch as it stands before its run in the cloud (CAN-6869): the
 * cloud runs only what the branch has on GitHub.
 */
export interface CloudRunCheckoutState {
  readonly branch: string;
  /** False while the branch has never been pushed. */
  readonly published: boolean;
  readonly unpushedCommits: number;
  readonly uncommittedChanges: boolean;
}

export const CLOUD_RUN_CHECKOUT_DIALOG_TEST_IDS = {
  dialog: 'cloud-run-checkout-dialog',
  confirm: 'cloud-run-checkout-confirm',
  cancel: 'cloud-run-checkout-cancel',
} as const;

/** Whether the confirmed start pushes the branch first. */
export function cloudRunCheckoutNeedsPush(
  state: CloudRunCheckoutState,
): boolean {
  return !state.published || state.unpushedCommits > 0;
}

/** The warning's sentence: what the cloud won't see, and what Push does. */
export function cloudRunCheckoutMessage(state: CloudRunCheckoutState): string {
  const commits =
    state.unpushedCommits === 1
      ? '1 commit'
      : `${state.unpushedCommits} commits`;
  const unpushed = !state.published
    ? "This branch isn't on GitHub yet."
    : state.unpushedCommits > 0
      ? `This branch has ${commits} that GitHub doesn't.`
      : null;
  const uncommitted = state.uncommittedChanges
    ? "Uncommitted changes stay on this computer and aren't part of the run."
    : null;
  return [
    'The cloud runs only what this branch has on GitHub.',
    unpushed,
    cloudRunCheckoutNeedsPush(state)
      ? 'Pushing sends the branch, then the run starts.'
      : null,
    uncommitted,
  ]
    .filter((sentence) => sentence !== null)
    .join(' ');
}

interface CloudRunCheckoutDialogBaseProps {
  readonly state: CloudRunCheckoutState;
  /** The push or start is running. */
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export type CloudRunCheckoutDialogProps = CloudRunCheckoutDialogBaseProps &
  ConfirmDialogErrorProps;

/**
 * Warns before a task's run in the cloud about what isn't on GitHub, and
 * offers to push (CAN-6869). Nothing is pushed unless the person confirms.
 */
export function CloudRunCheckoutDialog({
  state,
  busy = false,
  onConfirm,
  onCancel,
  ...errorProps
}: CloudRunCheckoutDialogProps): JSX.Element {
  const push = cloudRunCheckoutNeedsPush(state);
  const branch = <span className={REPLAY_MASK_CLASS}>{state.branch}</span>;
  return (
    <ConfirmDialog
      title={
        push ? (
          <span>Push “{branch}” and run in the cloud?</span>
        ) : (
          <span>Run “{branch}” in the cloud without uncommitted changes?</span>
        )
      }
      message={cloudRunCheckoutMessage(state)}
      confirmLabel={push ? 'Push and run' : 'Run in cloud'}
      busyLabel={push ? 'Pushing…' : 'Starting…'}
      busy={busy}
      {...errorProps}
      onConfirm={onConfirm}
      onCancel={onCancel}
      dataTestId={CLOUD_RUN_CHECKOUT_DIALOG_TEST_IDS.dialog}
      confirmTestId={CLOUD_RUN_CHECKOUT_DIALOG_TEST_IDS.confirm}
      cancelTestId={CLOUD_RUN_CHECKOUT_DIALOG_TEST_IDS.cancel}
    />
  );
}
