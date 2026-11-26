import {
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  UsageDataKey,
  UsageDataPolicySnapshot,
  UsageDataPreferences,
} from '@canopy/desktop-shared/types';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  USAGE_DATA_ROWS,
  UsageDataRows,
  type UsageDataRowKey,
  type UsageDataRowLocks,
  Button,
} from '@canopy/ui-shared/components';
import { brandText, getBrandHostedServicesUrl } from '@/lib/brand';
import { SettingsGroup, SettingsSection } from './SettingsLayout';
import { resolveUsageDataLocks } from './usageDataLocks';

/**
 * Compile-time guard that the shared row list covers exactly the stored
 * Usage data keys, so a new flow can't ship without a Settings switch.
 */
type AssertUsageDataRowParity = UsageDataKey extends UsageDataRowKey
  ? UsageDataRowKey extends UsageDataKey
    ? true
    : never
  : never;
const _usageDataRowParity: AssertUsageDataRowParity = true;
void _usageDataRowParity;

/**
 * Settings → Privacy → Usage data: one switch per outbound flow the product
 * works without. Opt-outs stay off even if saving fails; only opt-ins roll back.
 *
 * The stored preference always holds the member's own choice. Main resolves
 * the effective policy for the selected workspace context (an organization's
 * prohibitions, or the fail-closed state while the account can't be read) and
 * delivers it here; a prohibited row renders locked off with a badge naming
 * why, and never saves. Leaving the organization or switching to Personal
 * restores the member's choice, because nothing here rewrites it.
 */
export function UsageDataSection(): JSX.Element {
  const [preferences, setPreferences] = useState<UsageDataPreferences | null>(
    null,
  );
  const [snapshot, setSnapshot] = useState<UsageDataPolicySnapshot | null>(
    null,
  );
  const preferencesRef = useRef<UsageDataPreferences | null>(preferences);
  const hostedServicesUrl = getBrandHostedServicesUrl();

  useEffect(() => {
    preferencesRef.current = preferences;
  }, [preferences]);

  // Each loader returns a cancel function so a superseded response can't
  // overwrite newer state out of order.
  const load = useCallback((): (() => void) => {
    let cancelled = false;
    void window.api
      .loadPreferences()
      .then((prefs) => {
        if (!cancelled) {
          setPreferences(prefs.usageData);
        }
      })
      .catch((error: unknown) => {
        // The rows stay disabled until preferences load.
        reportClientAppError(error);
      });
    void window.api.observability
      .getUsageDataPolicy()
      .then((next) => {
        if (!cancelled) {
          setSnapshot(next);
        }
      })
      .catch((error: unknown) => {
        // Keep the last policy shown; the rows stay disabled until one loads.
        reportClientAppError(error);
      });
    return (): void => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancel = load();
    // Main broadcasts `preferencesChanged` when an org re-probe applies, and
    // the policy channel when the selected context or prohibitions change.
    const unsubscribePreferences = window.api.onPreferencesChanged(() => {
      cancel();
      cancel = load();
    });
    const unsubscribePolicy = window.api.observability.onUsageDataPolicyChanged(
      (next) => {
        setSnapshot(next);
      },
    );
    return (): void => {
      cancel();
      unsubscribePreferences();
      unsubscribePolicy();
    };
  }, [load]);

  // Skill safety check is protective, so no organization lock applies to it.
  const locks = useMemo(
    (): UsageDataRowLocks<UsageDataKey> => ({
      ...resolveUsageDataLocks(snapshot),
      skillSafetyCheck: null,
    }),
    [snapshot],
  );
  const ready = preferences !== null && snapshot !== null;

  const handleToggle = useCallback(
    (key: UsageDataKey, checked: boolean): void => {
      const previous = preferencesRef.current;
      if (!previous) {
        return;
      }
      const next: UsageDataPreferences = { ...previous, [key]: checked };
      // Updated now, not after render, so a quick second toggle builds on
      // this one instead of overwriting it.
      preferencesRef.current = next;
      setPreferences(next);
      void window.api
        .savePreferences({ usageData: { [key]: checked } })
        .catch((error: unknown) => {
          reportClientAppError(error);
          // A failed opt-out remains denied. A failed opt-in rolls back only
          // this key, and cannot undo a later opt-out.
          const current = preferencesRef.current;
          if (!checked || !current || current[key] !== checked) return;
          const rolledBack = { ...current, [key]: previous[key] };
          preferencesRef.current = rolledBack;
          setPreferences(rolledBack);
        });
    },
    [],
  );

  return (
    <SettingsSection
      title="Usage data"
      description={`Choose what ${brandText.appName} sends to help improve the app.`}
      dataTestId="usage-data-section"
      footer={
        hostedServicesUrl ? (
          <Button
            data-testid="usage-data-hosted-services-link"
            onClick={(): void => {
              void window.api.browser.openExternal({ url: hostedServicesUrl });
            }}
            variant="link"
            data-settings-control="link"
          >
            See everything that leaves your device
          </Button>
        ) : undefined
      }
    >
      <SettingsGroup dataTestId="usage-data-controls">
        <UsageDataRows
          rows={USAGE_DATA_ROWS}
          value={preferences}
          locks={locks}
          ready={ready}
          onToggle={handleToggle}
          idPrefix="settings-usage-data"
          testIdPrefix="usage-data"
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
