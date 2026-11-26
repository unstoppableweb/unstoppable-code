import { useCallback, useState, type JSX } from 'react';
import { FirstSendFailedNotice } from '@canopy/ui-shared/components';
import { retryFailedFirstSend } from '@/components/home/homeSend';
import { FIRST_SEND_FAILED_TITLE } from '@/components/home/homeModelFailureCopy';
import { requestModelPickerOpen } from '@/lib/composerShortcutRequests';
import type { ProvisionalFirstSendFailure } from '@/stores/chat/types';

interface FirstSendFailedSlotProps {
  target: { projectId: string; worktreeId: string; chatId: string };
  failure: Pick<ProvisionalFirstSendFailure, 'failureId' | 'message'>;
  /** Only the chat the user is looking at takes focus (CAN-5021). */
  active: boolean;
}

/**
 * Recovery for a Home first send whose model was refused after this chat
 * opened, in the composer's notice stack. The prompt stays in the transcript
 * above; choosing a model only updates this chat, and `Try again` sends the
 * same prompt once.
 */
export function FirstSendFailedSlot({
  target,
  failure,
  active,
}: FirstSendFailedSlotProps): JSX.Element | null {
  const { projectId, worktreeId, chatId } = target;
  const chooseModel = useCallback((): void => {
    requestModelPickerOpen({ scope: 'chat', projectId, worktreeId, chatId });
  }, [projectId, worktreeId, chatId]);
  // The retry claims the failure synchronously, so this notice unmounts
  // before a second press can reach it.
  const retry = useCallback((): void => {
    void retryFailedFirstSend({ projectId, worktreeId, chatId });
  }, [projectId, worktreeId, chatId]);
  // Closed per failure: a new failure has a new id, so it shows again.
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  if (dismissedId === failure.failureId) return null;
  return (
    <FirstSendFailedNotice
      title={FIRST_SEND_FAILED_TITLE}
      message={failure.message}
      onChooseModel={chooseModel}
      onRetry={retry}
      focusKey={active ? failure.failureId : null}
      onDismiss={(): void => setDismissedId(failure.failureId)}
    />
  );
}
