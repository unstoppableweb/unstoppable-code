import type { JSX } from 'react';
import { Notice, NoticeButton } from './Notice';

export interface AccountProxyFailureNoticeProps {
  /** The desktop's own message: why no proxy account could run the chat. */
  message: string;
  /** Open the desktop's proxy settings. Omit where they aren't available. */
  onOpenSettings?: () => void;
  dataTestId?: string;
}

/**
 * A chat the desktop's account proxy couldn't run because none of its
 * accounts can be used (turned off or needing a new sign-in). Shared
 * presentation; hosts render it in place of the raw error text and supply
 * the settings action only where the proxy settings exist.
 */
export function AccountProxyFailureNotice({
  message,
  onOpenSettings,
  dataTestId = 'chat-account-proxy-failure-notice',
}: AccountProxyFailureNoticeProps): JSX.Element {
  return (
    <Notice
      errorSource="account-proxy-failure"
      intent="destructive"
      role="none"
      data-chat-notice=""
      title="The account proxy can't run this chat."
      data-testid={dataTestId}
      actions={
        onOpenSettings ? (
          <NoticeButton
            variant="primary"
            data-testid={`${dataTestId}-open-settings`}
            onClick={onOpenSettings}
          >
            Open proxy settings
          </NoticeButton>
        ) : undefined
      }
    >
      {message}
    </Notice>
  );
}
