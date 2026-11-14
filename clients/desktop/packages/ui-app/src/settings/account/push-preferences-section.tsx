'use client';

import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import {
  DelayedLoadingPlaceholder,
  ErrorBanner,
  Skeleton,
} from '@canopy/ui-shared/components';
import {
  SETTINGS_CARD_ROW_CLASS,
  SettingsCard,
  SettingsCardSwitch,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import { useSettingsClient } from '../host';
import { useSettingsErrorCopy } from '../errors';
import type { SettingsFailure } from '../errors';

const PUSH_PREFERENCES_ERROR_SCOPE = 'settings.account.push-preferences';

function readPushEnabled(value: unknown): boolean | null {
  if (typeof value !== 'object' || value === null) return null;
  const record: Record<string, unknown> = { ...value };
  return typeof record.pushEnabled === 'boolean' ? record.pushEnabled : null;
}

const noop = (): void => undefined;

/** The opt-in row: its label and switch. */
function PushToggleRow({
  checked,
  disabled,
  onChange,
}: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: () => void;
}): JSX.Element {
  return (
    <div className={`mt-4 ${SETTINGS_CARD_ROW_CLASS}`}>
      <p className="text-s font-medium fg-primary">Allow push notifications</p>
      <SettingsCardSwitch
        checked={checked}
        label="Allow push notifications"
        disabled={disabled}
        dataTestId="account-push-toggle"
        onChange={onChange}
      />
    </div>
  );
}

/**
 * Push notification opt-in. The `/api/account/notification-preferences` route
 * and its `pushEnabled` column shipped for mobile some time ago but never had a
 * web surface, so the preference was only reachable from the phone. The
 * Notifications tab is its home.
 */
export function PushPreferencesSection(): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(PUSH_PREFERENCES_ERROR_SCOPE);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<SettingsFailure | null>(null);
  const [error, setError] = useState<SettingsFailure | null>(null);
  // Bumped by Retry so the load effect runs again.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const mounted = useRef(true);

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
        const body = await client.read('account.notifications.push.read', {});
        const value = readPushEnabled(body);
        if (!active) return;
        if (value === null) {
          throw new Error('Invalid push notification preferences response');
        }
        setPushEnabled(value);
        setLoadError(null);
      } catch (caught: unknown) {
        if (active) setLoadError(errorCopy.loadFailure(caught));
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return (): void => {
      active = false;
    };
  }, [client, errorCopy, loadAttempt]);

  const retryLoad = useCallback((): void => {
    // Back to the loading placeholder while the read runs again.
    setLoadError(null);
    setLoading(true);
    setLoadAttempt((attempt) => attempt + 1);
  }, []);

  const handleToggle = useCallback(async (): Promise<void> => {
    const previous = pushEnabled;
    const next = !previous;
    setPushEnabled(next);
    setSaving(true);
    setError(null);
    try {
      const body = await client.write('account.notifications.push.update', {
        pushEnabled: next,
      });
      const value = readPushEnabled(body);
      if (!mounted.current) return;
      setPushEnabled(value ?? next);
    } catch (caught: unknown) {
      if (!mounted.current) return;
      setPushEnabled(previous);
      setError(
        errorCopy.actionFailure(caught, {
          action: 'save notification settings',
        }),
      );
    } finally {
      if (mounted.current) setSaving(false);
    }
  }, [client, errorCopy, pushEnabled]);

  return (
    // `SettingsCard` rather than hand-rolled markup: this section was repeating
    // the card, title, and subtitle classes verbatim, so it rendered correctly
    // but had no icon and would drift the moment the shared card changed. The
    // sibling Work Digests card on this same tab already uses it.
    <SettingsCard
      title="Push notifications"
      subtitle="Send alerts to devices where you are signed in, such as when an agent needs your input."
      testId="account-push-preferences"
    >
      <ErrorBanner
        errorSource="push-preferences-section-load"
        error={loadError?.copy}
        details={loadError?.details}
        onRetry={retryLoad}
      />
      <ErrorBanner
        errorSource="push-preferences-section"
        error={error?.copy}
        details={error?.details}
      />

      {loading ? (
        <DelayedLoadingPlaceholder>
          <Skeleton
            loading
            label="Loading push notification settings"
            testId="settings-skeleton-form"
          >
            <PushToggleRow checked={false} disabled={false} onChange={noop} />
          </Skeleton>
        </DelayedLoadingPlaceholder>
      ) : loadError !== null ? null : (
        <PushToggleRow
          checked={pushEnabled}
          disabled={saving}
          onChange={() => void handleToggle()}
        />
      )}
    </SettingsCard>
  );
}
