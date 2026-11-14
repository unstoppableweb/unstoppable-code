'use client';

import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import {
  accountAppearanceSchema,
  DEFAULT_CHAT_DETAIL,
  type ChatDetail,
} from '@canopy/protocol/chat-detail';
import {
  CHAT_DETAIL_COPY,
  CHAT_DETAIL_LABEL,
  ChatDetailControl,
  DelayedLoadingPlaceholder,
  ErrorBanner,
  Skeleton,
} from '@canopy/ui-shared/components';
import {
  SETTINGS_CARD_ROW_CLASS,
  SettingsCard,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import { useSettingsClient } from '../host';
import { useSettingsErrorCopy } from '../errors';
import type { SettingsFailure } from '../errors';

const ACCOUNT_APPEARANCE_ERROR_SCOPE = 'settings.account.appearance';

function parseChatDetail(value: unknown): ChatDetail {
  const parsed = accountAppearanceSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid account appearance response');
  return parsed.data.chatDetail;
}

const noop = (): void => undefined;

/** The "Chats" card: the chat detail row and its picker. */
function ChatsCard({
  value,
  onChange,
  error,
}: {
  readonly value: ChatDetail;
  readonly onChange: (chatDetail: ChatDetail) => void;
  readonly error: SettingsFailure | null;
}): JSX.Element {
  return (
    <SettingsCard title="Chats" testId="account-appearance-chats">
      <div className="flex flex-col gap-3">
        {error !== null && (
          <ErrorBanner
            errorSource="chats-card"
            className=""
            error={error?.copy}
            details={error?.details}
          />
        )}
        <div
          className={SETTINGS_CARD_ROW_CLASS}
          data-testid="settings-chat-detail-row"
        >
          <div className="min-w-0">
            <p className="text-s font-medium fg-primary">{CHAT_DETAIL_LABEL}</p>
            <p className="text-s fg-secondary">
              {CHAT_DETAIL_COPY[value].description}
            </p>
          </div>
          <ChatDetailControl value={value} onChange={onChange} />
        </div>
      </div>
    </SettingsCard>
  );
}

/**
 * `/account/appearance`: how chats look, saved on the account. Today it
 * holds "Chat detail", the same picker desktop shows under Display →
 * Appearance. The level shows its requested value while the save runs and
 * goes back if the save fails. Chats read it when they load.
 */
// `account.appearance` page data is empty, so the page takes no props (it
// still satisfies the registry's `SettingsPageProps` component type).
export function AppearancePage(): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(ACCOUNT_APPEARANCE_ERROR_SCOPE);
  const [saved, setSaved] = useState<ChatDetail | null>(null);
  const [requested, setRequested] = useState<ChatDetail | null>(null);
  const [loadError, setLoadError] = useState<SettingsFailure | null>(null);
  const [error, setError] = useState<SettingsFailure | null>(null);
  // Bumped by Retry so the load effect runs again.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const mounted = useRef(true);
  // Only the newest save may settle the picker.
  const saveGeneration = useRef(0);
  // Saves go out one after another, so the server stores the latest pick
  // last even when picks overlap.
  const saveQueue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const load = async (): Promise<void> => {
      try {
        const next = parseChatDetail(
          await client.read('account.appearance.read', {}),
        );
        if (!active) return;
        setSaved(next);
        setLoadError(null);
      } catch (caught: unknown) {
        if (active) setLoadError(errorCopy.loadFailure(caught));
      }
    };
    void load();
    return (): void => {
      active = false;
    };
  }, [client, errorCopy, loadAttempt]);

  const retryLoad = useCallback((): void => {
    setLoadError(null);
    setSaved(null);
    setLoadAttempt((attempt) => attempt + 1);
  }, []);

  const onChange = useCallback(
    (chatDetail: ChatDetail): void => {
      const generation = ++saveGeneration.current;
      setRequested(chatDetail);
      setError(null);
      const save = async (): Promise<void> => {
        try {
          const next = parseChatDetail(
            await client.write('account.appearance.update', { chatDetail }),
          );
          // Saves finish in order, so each success is what the account holds.
          if (mounted.current) setSaved(next);
        } catch (caught: unknown) {
          if (mounted.current && generation === saveGeneration.current)
            setError(
              errorCopy.actionFailure(caught, { action: 'save your choice' }),
            );
        } finally {
          if (mounted.current && generation === saveGeneration.current)
            setRequested(null);
        }
      };
      saveQueue.current = saveQueue.current.then(save);
    },
    [client, errorCopy],
  );

  const shown = requested ?? saved;
  return (
    <div className="flex flex-col gap-6" data-testid="account-appearance-page">
      {loadError !== null ? (
        <ErrorBanner
          errorSource="appearance-page-load"
          error={loadError?.copy}
          details={loadError?.details}
          onRetry={retryLoad}
        />
      ) : shown === null ? (
        <DelayedLoadingPlaceholder>
          <Skeleton
            loading
            label="Loading appearance settings"
            testId="settings-skeleton-form"
          >
            <ChatsCard
              value={DEFAULT_CHAT_DETAIL}
              onChange={noop}
              error={null}
            />
          </Skeleton>
        </DelayedLoadingPlaceholder>
      ) : (
        <ChatsCard value={shown} onChange={onChange} error={error} />
      )}
    </div>
  );
}
