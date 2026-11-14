import { Stack, CodeBlock } from '@canopy/ui-shared/components';
import { type JSX } from 'react';
import { Notice } from '@canopy/ui-shared/components';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { DialogModal } from '@/components/shared/DialogModal';
import type { SplitPrExecutionErrorCode } from '@canopy/desktop-shared/types/github';
import { Button } from '@canopy/ui-shared/components';

export interface SplitFailureModalFailure {
  code?: SplitPrExecutionErrorCode;
  message: string;
  childIndex?: number;
  verifyTail?: string;
}

export interface SplitFailureModalProps {
  worktreeId: string;
  failure: SplitFailureModalFailure;
  /**
   * Whether a stored approved plan + snapshot are available for the key. When
   * false (e.g. after a renderer reload dropped the in-memory plan), Retry and
   * Edit plan are hidden and only Discard + a re-plan note remain.
   */
  canRecover: boolean;
  onLeave: () => void;
  onRetry: () => void;
  onEditPlan: () => void;
  onDiscard: () => void;
  onPlanNew: () => void;
}

/**
 * Immediate over-the-normal-UX surface for a Split PR run that settled
 * `status: 'failed'`. It is the loud, first surface the user hits; the inline
 * `SplitExecuteFailureNotice` in PullRequestSection remains as the persistent
 * surface after the modal is dismissed (Leave), so the two stay consistent —
 * the modal shows first and dismissing leaves the notice behind.
 *
 * Recovery actions:
 *  - Retry re-enters the LOCKED workflow via `startSplitWorkflow` mode
 *    `'resume'`, which resumes from the checkpointed engine map using the
 *    stored plan+snapshot (Execute step active).
 *  - Edit plan re-enters the LOCKED workflow via mode `'review'`, landing on
 *    the Review step with the STORED plan (no LLM re-plan).
 *  - Both are hidden when no stored plan+snapshot exist (`canRecover` false):
 *    only Discard + a "re-planning needed" note remain, and Plan new split
 *    routes through the pre-flight modal.
 *  - `plan_mismatch` offers Discard prominently since the persisted map was
 *    never transitioned to `failed` for that code.
 */
export function SplitFailureModal({
  worktreeId,
  failure,
  canRecover,
  onLeave,
  onRetry,
  onEditPlan,
  onDiscard,
  onPlanNew,
}: SplitFailureModalProps): JSX.Element {
  const isMismatch = failure.code === 'plan_mismatch';

  return (
    <DialogModal
      inset="flush"
      onClose={onLeave}
      title="Split PR failed"
      subtitle={`Worktree ${worktreeId}`}
      maxWidth="lg"
      dataTestId="split-failure-modal"
    >
      <div className="flex flex-col px-6 py-4 gap-3">
        <Notice
          intent="attention"
          role="none"
          data-testid="split-failure-message"
          detail={
            failure.childIndex !== undefined ||
            failure.verifyTail !== undefined ? (
              <Stack gap="inline">
                {failure.childIndex !== undefined && (
                  <span data-testid="split-failure-child-index">
                    Failed on child #{failure.childIndex}.
                  </span>
                )}
                {failure.verifyTail !== undefined && (
                  <CodeBlock
                    data-testid="split-failure-verify-tail"
                    variant="snippet"
                    tone="inherit"
                    className="max-h-40"
                  >
                    {failure.verifyTail}
                  </CodeBlock>
                )}
              </Stack>
            ) : undefined
          }
        >
          <span
            className={`${POSTHOG_REPLAY_BLOCK_CLASS} whitespace-pre-wrap break-words`}
          >
            {failure.message}
          </span>
        </Notice>

        {isMismatch && (
          <p
            data-testid="split-failure-mismatch-note"
            className="text-2xs fg-secondary"
          >
            The approved plan no longer matches the split already in progress.
            Discard the split state to start over.
          </p>
        )}

        {!canRecover && (
          <p
            data-testid="split-failure-replan-note"
            className="text-2xs fg-secondary"
          >
            The reviewed plan is no longer available in this session. Plan a new
            split to continue, or discard the split state.
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t px-6 py-3">
        <Button
          size="compact"
          onClick={onLeave}
          data-testid="split-failure-leave"
        >
          Leave
        </Button>
        {/* Discard is irreversible but sits beside routine actions, so it is
            the quiet destructive variant; the forward action keeps the
            primary. */}
        <Button
          variant="ghost-destructive"
          size="compact"
          onClick={onDiscard}
          data-testid="split-failure-discard"
        >
          Discard split state
        </Button>
        {canRecover ? (
          <>
            <Button
              size="compact"
              onClick={onEditPlan}
              data-testid="split-failure-edit-plan"
            >
              Edit plan
            </Button>
            <Button
              variant="primary"
              size="compact"
              onClick={onRetry}
              data-testid="split-failure-retry"
            >
              Try again
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            size="compact"
            onClick={onPlanNew}
            data-testid="split-failure-plan-new"
          >
            Plan new split
          </Button>
        )}
      </div>
    </DialogModal>
  );
}
