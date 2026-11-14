import type { JSX } from 'react';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import { queuedMessageEditFailureKey } from '@/stores/chat/slices/queue';
import { useChatStore, type QueuedChatMessage } from '@/stores/chatStore';

interface QueuedMessageEditFailureBannerProps {
  readonly message: QueuedChatMessage;
  readonly className?: string;
}

/**
 * A failed attempt to edit this queued message, shown on its row. It stays
 * until it is dismissed, the next edit starts, or the row's text changes.
 */
export function QueuedMessageEditFailureBanner({
  message,
  className = '',
}: QueuedMessageEditFailureBannerProps): JSX.Element | null {
  const entryKey = queuedMessageEditFailureKey(message);
  const failure = useChatStore((state) =>
    entryKey === undefined
      ? undefined
      : state.queuedMessageEditFailures[entryKey],
  );
  const dismiss = useChatStore(
    (state) => state.dismissQueuedMessageEditFailure,
  );
  if (entryKey === undefined || !failure || failure.text !== message.text)
    return null;
  return (
    <DesktopErrorBanner
      errorSource="queued-message-edit-error"
      className={className}
      testId="queued-message-edit-error"
      error={failure.error}
      {...(failure.details === undefined ? {} : { details: failure.details })}
      onDismiss={(): void => dismiss(entryKey)}
    />
  );
}
