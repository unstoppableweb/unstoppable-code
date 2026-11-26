import { memo, type JSX } from 'react';
import type { SafetyDenyReason } from '@canopy/protocol/approvals';
import { ShieldIcon } from '../../icons/AppIcons';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import { Notice } from '../../primitives/Notice';

const PROMPT_LIMIT = 'This call cannot be approved from a prompt.';

/** Exhaustive per reason, so a new safety rule cannot ship without copy. */
export const APPROVAL_SAFETY_DENIED_COPY: Record<
  SafetyDenyReason,
  { title: string; message: string }
> = {
  'force-push': {
    title: 'Force-push blocked by a safety rule.',
    message: PROMPT_LIMIT,
  },
  'destructive-delete': {
    title: 'Destructive delete blocked by a safety rule.',
    message: PROMPT_LIMIT,
  },
  'disk-write': {
    title: 'Disk write blocked by a safety rule.',
    message: PROMPT_LIMIT,
  },
  'unverifiable-command': {
    title: 'Command blocked by a safety rule.',
    message: `Its effect could not be checked. ${PROMPT_LIMIT}`,
  },
};

export interface ApprovalSafetyDeniedNoticeProps {
  reason: SafetyDenyReason;
  /** Bounded, redacted display text; rendered as text, never markup. */
  command: string;
}

/**
 * Transcript receipt for a tool call a safety rule denied. Explanatory only:
 * no action, because a prompt cannot approve the call. Persistence and
 * placement beside the denied tool row belong to the host transcript.
 *
 * Memoized so ordinary transcript rerenders keep the same live-region text
 * and never announce it again.
 */
function ApprovalSafetyDeniedNoticeComponent({
  reason,
  command,
}: ApprovalSafetyDeniedNoticeProps): JSX.Element {
  const copy = APPROVAL_SAFETY_DENIED_COPY[reason];
  return (
    <Notice
      role="status"
      intent="attention"
      icon={<ShieldIcon size={16} aria-hidden="true" />}
      title={copy.title}
      data-testid="approval-safety-denied-notice"
      data-safety-reason={reason}
      detail={
        command.length > 0 ? (
          <code
            data-testid="approval-safety-denied-command"
            // The whole command line is conversation content for replay.
            className={`${REPLAY_BLOCK_CLASS} block whitespace-pre-wrap font-mono wrap-anywhere`}
          >
            {command}
          </code>
        ) : undefined
      }
    >
      {copy.message}
    </Notice>
  );
}

export const ApprovalSafetyDeniedNotice = memo(
  ApprovalSafetyDeniedNoticeComponent,
);
