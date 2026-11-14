import type { JSX } from 'react';
import { Notice, NoticeButton } from './Notice';

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
            Sign in to Claude
          </NoticeButton>
        ) : undefined
      }
    >
      This request used AI Credits, but that connection could not read the
      conversation.
      {!onSignIn ? ' Sign in to Claude on your computer to continue.' : null}
    </Notice>
  );
}
