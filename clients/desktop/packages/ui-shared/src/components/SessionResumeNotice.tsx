import type { JSX } from 'react';
import { Notice, NoticeButton } from '../primitives/Notice';

export const SESSION_RESUME_NOTICE_COPY = {
  title: "Couldn't resume this chat",
  message:
    'Your last message will open as a draft. Attach files again before sending.',
  action: 'New chat with message',
};

/** Same optional recovery on desktop and Portal; never submits a prompt. */
export function SessionResumeNotice({
  onCreateChat,
  disabled = false,
}: {
  onCreateChat: () => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <Notice
      intent="attention"
      title={SESSION_RESUME_NOTICE_COPY.title}
      data-testid="session-resume-notice"
      actions={
        <NoticeButton
          variant="primary"
          onClick={onCreateChat}
          disabled={disabled}
        >
          {SESSION_RESUME_NOTICE_COPY.action}
        </NoticeButton>
      }
    >
      {SESSION_RESUME_NOTICE_COPY.message}
    </Notice>
  );
}
