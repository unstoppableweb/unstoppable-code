import type { JSX } from 'react';
import type { CodexAccountModelAccessFailure } from '@canopy/protocol/auth-recovery';
import { Notice, NoticeButton } from './Notice';

export interface CodexAccountModelNoticeProps {
  failure: CodexAccountModelAccessFailure;
  /**
   * Switch the chat to `failure.fallbackModel` and resend. Omit on read-only
   * surfaces; the notice is also read-only when the failure has no fallback.
   */
  onUseFallback?: () => void;
  busy?: boolean;
  disabled?: boolean;
  dataTestId?: string;
}

/**
 * A turn the signed-in ChatGPT account was refused because it cannot use the
 * model (CAN-4716). Shared presentation; the switch and resend stay in the
 * host. Hosts render this in place of the raw error text, which stays only in
 * the stored block.
 */
export function CodexAccountModelNotice({
  failure,
  onUseFallback,
  busy = false,
  disabled = false,
  dataTestId = 'chat-codex-account-model-notice',
}: CodexAccountModelNoticeProps): JSX.Element {
  const fallbackLabel =
    failure.fallbackModel !== undefined
      ? failure.fallbackModelLabel
      : undefined;
  const actionable = onUseFallback !== undefined && fallbackLabel !== undefined;
  return (
    <Notice
      errorSource="codex-account-model"
      intent="destructive"
      role="none"
      title={`Your ChatGPT account can't use ${failure.modelLabel}.`}
      data-testid={dataTestId}
      actions={
        actionable ? (
          <NoticeButton
            variant="primary"
            data-testid={`${dataTestId}-use-fallback`}
            busy={busy}
            disabled={disabled}
            onClick={onUseFallback}
          >
            {`Use ${fallbackLabel}`}
          </NoticeButton>
        ) : undefined
      }
    >
      {fallbackLabel === undefined ? 'Choose another model.' : null}
    </Notice>
  );
}
