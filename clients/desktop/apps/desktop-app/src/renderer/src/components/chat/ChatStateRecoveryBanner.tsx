import type { JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useChatStore } from '@/stores/chatStore';
import {
  CHAT_STATE_COMMAND_FAILED_TITLE,
  CHAT_STATE_CONFLICT_TITLE,
  CHAT_STATE_REFRESHING_TOAST,
  CHAT_STATE_REFRESH_ERROR_HEADING,
  CHAT_STATE_REFRESH_ERROR_HELPER,
  CHAT_STATE_REFRESH_RETRY_LABEL,
} from '@/stores/chat/revisioned-copy';

/**
 * Revisioned chat-state recovery treatments (frontend plan, "Required UI
 * Behavior"). Renders nothing in the normal live path:
 *
 * - While a delta gap forces a one-shot snapshot refresh, the last good
 *   transcript stays visible above and this shows the refreshing toast.
 * - When the refresh fails, an inline error keeps the last transcript and
 *   offers an explicit Retry (destructive commands are never auto-retried).
 * - Stale-conflict and non-conflict command failures surface their approved
 *   copy as a dismissible notice.
 *
 * Every treatment is a shared `Notice`, stacked between the transcript and
 * the composer. The wrapper owns the placement inset that the former
 * edge-to-edge `border-t` rows did not need.
 */
export interface ChatStateRecoveryBannerProps {
  projectId: string;
  worktreeId: string;
}

export function ChatStateRecoveryBanner({
  projectId,
  worktreeId,
}: ChatStateRecoveryBannerProps): JSX.Element {
  const key = `${projectId}/${worktreeId}`;
  // Optional-chained: host surfaces render this banner unconditionally, and
  // partial store doubles in tests may omit the revisioned slice.
  const phase = useChatStore((s) => s.chatStateSync?.[key]?.phase);
  const notice = useChatStore(useShallow((s) => s.chatStateNotices?.[key]));
  const retryChatStateRefresh = useChatStore((s) => s.retryChatStateRefresh);
  const dismissChatStateNotice = useChatStore((s) => s.dismissChatStateNotice);

  const showRefreshing = phase === 'refreshing';
  const showRefreshError = phase === 'refresh_error';
  useCurrentUiStateReporter(
    'chat.stateRecovery',
    showRefreshing || showRefreshError || notice
      ? {
          ...(showRefreshing
            ? { phase: 'refreshing' }
            : showRefreshError
              ? { phase: 'refresh_error' }
              : {}),
          ...(notice ? { noticeKind: notice.kind } : {}),
          retryAvailable: showRefreshError,
          dismissAvailable: Boolean(notice),
        }
      : null,
  );
  if (!showRefreshing && !showRefreshError && !notice) {
    return <></>;
  }

  return (
    <div
      data-testid="chat-state-recovery-banner"
      className="mx-auto flex w-full max-w-[var(--chat-composer-shell-width)] chat-width-transition shrink-0 flex-col gap-2 px-4 pt-2"
    >
      {showRefreshing && (
        <Notice
          intent="neutral"
          icon={null}
          role="status"
          data-testid="chat-state-refreshing-toast"
        >
          {CHAT_STATE_REFRESHING_TOAST}
        </Notice>
      )}
      {showRefreshError && (
        <Notice
          errorSource="chat-state-refresh-error"
          intent="destructive"
          data-testid="chat-state-refresh-error"
          title={CHAT_STATE_REFRESH_ERROR_HEADING}
          actions={
            <NoticeButton
              variant="primary"
              data-testid="chat-state-refresh-retry"
              onClick={(): void => {
                retryChatStateRefresh(projectId, worktreeId);
              }}
            >
              {CHAT_STATE_REFRESH_RETRY_LABEL}
            </NoticeButton>
          }
        >
          {CHAT_STATE_REFRESH_ERROR_HELPER}
        </Notice>
      )}
      {notice && notice.kind === 'unavailable' && (
        // A change this chat's backend doesn't serve (CAN-6646): nothing
        // failed, so it says what isn't available and clears by itself.
        <Notice
          intent="neutral"
          role="status"
          data-testid="chat-state-unavailable-notice"
          onDismiss={(): void => {
            dismissChatStateNotice(projectId, worktreeId);
          }}
          dismissLabel="Dismiss chat state notice"
          dismissTestId="chat-state-notice-dismiss"
        >
          {notice.message}
        </Notice>
      )}
      {notice && notice.kind !== 'unavailable' && (
        <Notice
          intent="attention"
          // A rejected or failed change is interrupted news, so it is announced
          // assertively even though it uses the attention look.
          role="alert"
          data-testid={
            notice.kind === 'conflict'
              ? 'chat-state-conflict-notice'
              : 'chat-state-command-failed-notice'
          }
          title={
            notice.kind === 'conflict'
              ? CHAT_STATE_CONFLICT_TITLE
              : CHAT_STATE_COMMAND_FAILED_TITLE
          }
          onDismiss={(): void => {
            dismissChatStateNotice(projectId, worktreeId);
          }}
          dismissLabel="Dismiss chat state notice"
          dismissTestId="chat-state-notice-dismiss"
        >
          {notice.message}
        </Notice>
      )}
    </div>
  );
}
