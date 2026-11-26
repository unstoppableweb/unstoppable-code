import type { JSX } from 'react';
import { Notice, NoticeButton } from '../primitives/Notice';

export const OLDER_FORMAT_CHAT_NOTICE_COPY = {
  title: "This chat uses an older format, so it can't continue",
  message: 'Start a new chat to keep working.',
  action: 'New chat',
};

/** Takes the composer's place on a read-only cloud chat in the v1 format (CAN-7747). */
export function OlderFormatChatNotice({
  onCreateChat,
  disabled = false,
}: {
  onCreateChat: () => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <Notice
      title={OLDER_FORMAT_CHAT_NOTICE_COPY.title}
      data-testid="older-format-chat-notice"
      actions={
        <NoticeButton
          variant="primary"
          onClick={onCreateChat}
          disabled={disabled}
        >
          {OLDER_FORMAT_CHAT_NOTICE_COPY.action}
        </NoticeButton>
      }
    >
      {OLDER_FORMAT_CHAT_NOTICE_COPY.message}
    </Notice>
  );
}
