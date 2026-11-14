import type { JSX } from 'react';
import type {
  ApprovalPromptDecision,
  ApprovalPromptRequest,
} from '@canopy/protocol/approvals';
import { DialogModal, ToolApprovalCard } from '@canopy/ui-shared/components';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

export interface ReachBackApprovalDialogProps {
  /** Names the cloud chat, the server and what it wants to run. */
  readonly pending: ApprovalPromptRequest;
  readonly onRespond: (
    requestId: string,
    decision: ApprovalPromptDecision,
  ) => Promise<void>;
}

/**
 * Asks before a cloud chat runs a tool, or starts a server, on this computer
 * (CAN-6176 Q3). The chat approval card with Allow once and Deny only:
 * nothing it decides is saved, so the next call asks again. Focus starts on
 * the card, never on Allow once, and closing it denies.
 */
export function ReachBackApprovalDialog({
  pending,
  onRespond,
}: ReachBackApprovalDialogProps): JSX.Element {
  return (
    <DialogModal
      title="A cloud chat is asking"
      variant="confirm"
      maxWidth="lg"
      trapFocus
      // It opens while the person may be typing: Enter mustn't allow a call.
      initialFocus="dialog"
      dataTestId="reach-back-approval"
      onClose={(): void => {
        void onRespond(pending.requestId, { behavior: 'deny', scope: 'once' });
      }}
    >
      {/* The card names the chat, whose title the person wrote. */}
      <div className={REPLAY_MASK_CLASS}>
        <ToolApprovalCard
          pending={pending}
          onRespond={onRespond}
          ruleScopes={false}
          denyReason={false}
          denyAndStop={false}
        />
      </div>
    </DialogModal>
  );
}
