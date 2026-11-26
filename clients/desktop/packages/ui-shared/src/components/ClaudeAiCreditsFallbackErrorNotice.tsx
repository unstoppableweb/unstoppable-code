import type { JSX } from 'react';
import { Notice, NoticeButton } from '../primitives/Notice';

export interface ClaudeAiCreditsFallbackErrorNoticeProps {
  /** Omit when this host cannot start the native provider sign-in flow. */
  onSignIn?: () => void;
}

/** Shared presentation; route selection and original errors stay in the host. */
export function ClaudeAiCreditsFallbackErrorNotice({
  onSignIn,
}: ClaudeAiCreditsFallbackErrorNoticeProps): JSX.Element {
  return (
    <Notice
      errorSource="claude-ai-credits-fallback-error"
      displayErrorCode="external.sign_in_required"
      intent="destructive"
      role="none"
      title="Claude is signed out."
      data-testid="claude-ai-credits-fallback-error"
      actions={
        onSignIn ? (
          <NoticeButton
            variant="primary"
            data-testid="claude-fallback-sign-in"
            onClick={onSignIn}
          >
            Reconnect Claude
          </NoticeButton>
        ) : undefined
      }
    >
      {/* Credits can't stand in here: trying them again fails the same way. */}
      {onSignIn
        ? "Credits couldn't run this chat in its place. Reconnect Claude, then send your message again."
        : "Credits couldn't run this chat in its place. Reconnect Claude on your computer, then send your message again."}
    </Notice>
  );
}
