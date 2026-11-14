import { type JSX, useCallback, useEffect, useState } from 'react';
import type { ChatDetail } from '@canopy/protocol/chat-detail';
import {
  CHAT_DETAIL_COPY,
  CHAT_DETAIL_LABEL,
  ChatDetailControl,
  ErrorBanner,
} from '@canopy/ui-shared/components';
import {
  ensureChatDetailSubscription,
  useChatDetailStore,
} from '@/stores/chatDetailStore';
import { SettingsRow } from './SettingsLayout';

const SAVE_ERROR_MESSAGE = 'Could not save this setting. Try again.';

/**
 * Display → Appearance → "Chat detail": how much of an agent's work chats
 * show. The picker is shared with web Account → Appearance; this row saves
 * the choice to this computer's preferences, so open chats change as soon as
 * it does, and a change saved in another window shows here too. Saves are
 * optimistic and roll back to the last saved level if they fail.
 */
export function ChatDetailSettingsRow(): JSX.Element {
  const detail = useChatDetailStore((state) => state.detail);
  const hydrated = useChatDetailStore((state) => state.hydrated);
  const setDetail = useChatDetailStore((state) => state.setDetail);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    ensureChatDetailSubscription();
  }, []);

  const handleChange = useCallback(
    (next: ChatDetail): void => {
      setSaveError(null);
      void setDetail(next).catch(() => {
        setSaveError(SAVE_ERROR_MESSAGE);
      });
    },
    [setDetail],
  );

  return (
    <SettingsRow
      label={CHAT_DETAIL_LABEL}
      description={CHAT_DETAIL_COPY[detail].description}
      dataTestId="settings-chat-detail-row"
      control={
        <ChatDetailControl
          value={hydrated ? detail : null}
          onChange={handleChange}
        />
      }
    >
      <ErrorBanner
        errorSource="chat-detail-settings-row-save"
        error={saveError}
        className=""
      />
    </SettingsRow>
  );
}
