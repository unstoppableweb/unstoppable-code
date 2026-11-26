import { CodeBlock } from '../../primitives/CodeBlock';
import type { JSX, RefObject } from 'react';
import type { ApprovalFileChange } from '@canopy/protocol/approvals';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import { DialogModal } from '../../primitives/DialogModal';
import { ApprovalFileChangePreview } from './ApprovalFileChangePreview';

/** What the dialog body shows: plain text, or a proposed file change. */
export type ApprovalContentModalContent =
  | { kind: 'text'; text: string }
  | { kind: 'change'; change: ApprovalFileChange };

export interface ApprovalContentModalProps {
  title: string;
  /** Tool input, such as a file path: blocked from session replay. */
  subtitle?: string;
  /** The complete text, or the change as delivered (already bounded upstream). */
  content: ApprovalContentModalContent;
  onClose: () => void;
  /** Where focus returns if the control that opened the modal is gone. */
  restoreFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * Full view for a tool approval's content or rule target (CAN-3001). The card
 * and the allow/deny menu headers only ever show a bounded preview; this
 * portaled dialog is the one place the whole payload renders, inside
 * `DialogModal`'s scrollable body so a multi-thousand-line script stays
 * navigable without growing the composer. A file change renders without the
 * compact limits (CAN-5165); text capped before delivery stays unavailable.
 */
export function ApprovalContentModal({
  title,
  subtitle,
  content,
  onClose,
  restoreFocusRef,
}: ApprovalContentModalProps): JSX.Element {
  return (
    <DialogModal
      inset="flush"
      onClose={onClose}
      title={title}
      subtitle={
        subtitle === undefined ? undefined : (
          <span
            data-testid="tool-approval-content-modal-subtitle"
            className={`${REPLAY_BLOCK_CLASS} break-all`}
          >
            {subtitle}
          </span>
        )
      }
      titleId="tool-approval-content-modal-title"
      maxWidth="3xl"
      dataTestId="tool-approval-content-modal"
      trapFocus
      restoreFocusRef={restoreFocusRef}
    >
      {/* The flush body's own inset: 16px below the header, 24px elsewhere. */}
      {content.kind === 'text' ? (
        <div className="px-6 pb-6 pt-4">
          <CodeBlock
            data-testid="tool-approval-content-modal-body"
            variant="approval-document"
            size="xs"
            wrap="all"
            tone="muted-primary"
            replay="block"
            overflow="visible"
            selectable
          >
            {content.text}
          </CodeBlock>
        </div>
      ) : (
        <div
          data-testid="tool-approval-content-modal-body"
          className={`${REPLAY_BLOCK_CLASS} select-text px-6 pb-6 pt-4`}
        >
          <ApprovalFileChangePreview change={content.change} mode="expanded" />
        </div>
      )}
    </DialogModal>
  );
}
