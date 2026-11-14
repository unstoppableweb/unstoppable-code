import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import type {
  CloudDigestPreferences,
  CloudDigestPreferencesState,
} from '@canopy/desktop-shared/types';
import {
  DEFAULT_DIGEST_PREFERENCES,
  DIGEST_DAILY_DESCRIPTION,
  DIGEST_WEEKDAY_LABELS,
  digestMonthlyDescription,
  digestOrdinalDay,
  digestWeeklyDescription,
} from '@canopy/protocol/digests';
import { toAppError } from '@canopy/protocol/app-errors';
import {
  reportClientAppError,
  resolveClientAppError,
} from '@canopy/desktop-instrumentation/client';
import {
  Button,
  InlineTextSkeleton,
  SettingsSelect,
  ToggleSwitch,
  type SettingsSelectOption,
} from '@canopy/ui-shared/components';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import { brandText } from '@/lib/brand';
import { inlineFailure, type InlineFailure } from '@/lib/inline-app-error';
import {
  SettingsDescriptionLoading,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsSubRow,
} from './SettingsLayout';

/**
 * Only the boolean cadence toggles. This deliberately no longer reads
 * `keyof CloudDigestPreferences`: the contract now also carries the two numeric
 * anchors, and indexing a switch by a numeric key would not type-check.
 */
type CadenceField = 'daily' | 'weekly' | 'monthly';

/** The anchor field a cadence is configured by, if it has one. */
type AnchorField = 'weeklyAnchorDay' | 'monthlyAnchorDay';

const WEEKLY_ANCHOR_OPTIONS: readonly number[] = [1, 2, 3, 4, 5, 6, 7];
const MONTHLY_ANCHOR_OPTIONS: readonly number[] = Array.from(
  { length: 31 },
  (_, index) => index + 1,
);

const WEEKLY_ANCHOR_SELECT_OPTIONS: readonly SettingsSelectOption[] =
  WEEKLY_ANCHOR_OPTIONS.map((day) => ({
    value: String(day),
    label: DIGEST_WEEKDAY_LABELS[day - 1],
  }));

const MONTHLY_ANCHOR_SELECT_OPTIONS: readonly SettingsSelectOption[] =
  MONTHLY_ANCHOR_OPTIONS.map((day) => ({
    value: String(day),
    label: digestOrdinalDay(day),
  }));

const CADENCES: ReadonlyArray<{
  field: CadenceField;
  label: string;
  anchorField: AnchorField | null;
  // Copy comes from `@canopy/protocol/digests` so this surface and the web
  // preferences card cannot drift; hand-copied cadence strings here were the
  // original reason for putting them in the shared package.
  describe: (preferences: CloudDigestPreferences) => string;
}> = [
  {
    field: 'daily',
    label: 'Daily',
    anchorField: null,
    describe: () => DIGEST_DAILY_DESCRIPTION,
  },
  {
    field: 'weekly',
    label: 'Weekly',
    anchorField: 'weeklyAnchorDay',
    describe: (preferences) =>
      digestWeeklyDescription(preferences.weeklyAnchorDay),
  },
  {
    field: 'monthly',
    label: 'Monthly',
    anchorField: 'monthlyAnchorDay',
    describe: (preferences) =>
      digestMonthlyDescription(preferences.monthlyAnchorDay),
  },
];

/**
 * Work-digest cadences for the connected cloud account.
 *
 * These are **cloud-account settings, not local preferences**: every read and
 * write goes straight to the server through the main process, and nothing is
 * mirrored into `preferences.json`. That is deliberate — the digest is sent by
 * the server to one email address, so a per-machine copy could only ever
 * disagree with what actually gets delivered.
 *
 * The section renders nothing unless the server confirms the surface exists.
 * `available: false` covers no connected cloud account, the
 * `canopy-digests-enabled` flag being off, and a server that predates the
 * digest routes — the desktop never re-derives any of those locally, so the
 * flag keeps one source of truth.
 */
export function CloudDigestSettings(): JSX.Element | null {
  const [state, setState] = useState<CloudDigestPreferencesState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<InlineFailure | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.api
      .loadCloudDigestPreferences()
      .then((next) => {
        if (cancelled) return;
        setState(next);
        setError(
          next.available && !next.resolved
            ? { error: 'Could not load digest settings.' }
            : null,
        );
      })
      .catch((caught: unknown) => {
        // The handler is fail-soft by contract, so this only fires if the IPC
        // bridge itself is missing (older shell). Hide rather than error, but
        // keep the defect on record.
        reportClientAppError(caught);
        if (!cancelled) {
          setState({
            available: false,
            resolved: true,
            preferences: DEFAULT_DIGEST_PREFERENCES,
          });
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback(
    async (next: CloudDigestPreferences): Promise<void> => {
      // Only a resolved state carries the account's real cadences. Writing
      // from an unresolved one would PATCH the placeholder defaults back as if
      // the user had chosen them, silently rewriting settings we failed to read.
      if (!state || !state.resolved) return;
      // Optimistic, but still marked resolved: the row stays interactive while
      // the round trip is in flight and reverts wholesale if the server
      // disagrees.
      setState({ available: true, resolved: true, preferences: next });
      setSaving(true);
      setError(null);
      const previous = state;
      try {
        const result = await window.api.saveCloudDigestPreferences(next);
        if (!mounted.current) return;
        if (!result.available) {
          // Same contract the load path honors: the surface no longer exists
          // for this account (flag flipped off, credential revoked), so hide
          // it rather than stranding toggles that can never succeed again.
          setState(result);
          return;
        }
        if (result.resolved) {
          setState(result);
        } else {
          setState(previous);
          setError({ error: 'Could not save digest settings.' });
        }
      } catch (caught: unknown) {
        // The handler is fail-soft by contract, so this only fires if the IPC
        // bridge itself is missing. Revert rather than leaving every toggle
        // permanently disabled behind a `saving` flag that never clears.
        const appError = toAppError(resolveClientAppError(caught));
        if (!mounted.current) return;
        setState(previous);
        if (appError)
          setError(inlineFailure(appError, 'Could not save digest settings.'));
      } finally {
        if (mounted.current) setSaving(false);
      }
    },
    [state],
  );

  const handleToggle = useCallback(
    (field: CadenceField): void => {
      if (!state) return;
      void persist({
        ...state.preferences,
        [field]: !state.preferences[field],
      });
    },
    [persist, state],
  );

  const handleAnchorChange = useCallback(
    (field: AnchorField, rawValue: string): void => {
      if (!state) return;
      const parsed = Number.parseInt(rawValue, 10);
      if (!Number.isInteger(parsed)) return;
      void persist({ ...state.preferences, [field]: parsed });
    },
    [persist, state],
  );

  const handleOpenDigests = useCallback((): void => {
    // `openAuthenticatedPortalPage` returns false rather than throwing on every
    // realistic failure — it degrades to `openUnauthenticated`, which itself
    // swallows errors and returns false when the base URL is unconfigured. The
    // other call sites (openBillingPage, CanopyPortalModal) honor that; ignoring
    // it here made the button silently do nothing, and the bare `void` left an
    // unhandled rejection on the one path that does reject (missing IPC bridge).
    void window.api
      .openAuthenticatedPortalPage('/account/digests')
      .then((opened) => {
        if (!opened && mounted.current) {
          setError({ error: 'Could not open digests in your browser.' });
        }
      })
      .catch((caught: unknown) => {
        const appError = toAppError(resolveClientAppError(caught));
        if (appError && mounted.current) {
          setError(
            inlineFailure(appError, 'Could not open digests in your browser.'),
          );
        }
      });
  }, []);

  const handleRetry = useCallback((): void => {
    setError(null);
    void window.api
      .loadCloudDigestPreferences()
      .then((next) => {
        if (!mounted.current) return;
        setState(next);
        setError(
          next.available && !next.resolved
            ? { error: 'Could not load digest settings.' }
            : null,
        );
      })
      .catch((caught: unknown) => {
        const appError = toAppError(resolveClientAppError(caught));
        if (appError && mounted.current)
          setError(inlineFailure(appError, 'Could not load digest settings.'));
      });
  }, []);

  if (!state || !state.available) return null;

  // An unresolved load has no idea what the account's cadences are. Rendering
  // `state.preferences` here would show the weekly-only placeholder as if it
  // were the user's setting — a user whose account has weekly OFF would see
  // "Weekly" on below "Could not load digest settings." That is exactly the
  // fiction the main process refuses to make (it returns `resolved: false`
  // precisely so "every cadence off" is never asserted). Show no switch at all
  // and a retry, so nothing is claimed and nothing can be written.
  const unresolved = !state.resolved;
  // A retry clears the load error until it answers, so an unresolved state
  // without an error is a retry in flight.
  const retrying = unresolved && error === null;

  return (
    // Returns the section itself so it sits directly in the Notifications
    // page, and disappears with it when the surface is unavailable and this
    // component renders null.
    <SettingsSection
      title="Work digests"
      description={
        <>
          A periodic summary of your {brandText.appName} activity, emailed to
          you. Applies everywhere you are signed in to {brandText.serverName}.
        </>
      }
      dataTestId="settings-cloud-digests"
    >
      <DesktopErrorBanner
        errorSource="cloud-digests-error"
        className=""
        error={error?.error}
        {...(error?.details === undefined ? {} : { details: error.details })}
        testId="cloud-digests-error"
        {...(unresolved ? { onRetry: handleRetry } : {})}
      />

      <SettingsGroup>
        {CADENCES.map((cadence) => {
          const toggleId = `cloud-digest-toggle-${cadence.field}`;
          const anchorId = `cloud-digest-anchor-${cadence.field}`;
          const anchorField = cadence.anchorField;
          return (
            <SettingsRow
              key={cadence.field}
              label={cadence.label}
              htmlFor={unresolved ? undefined : toggleId}
              description={
                // An unresolved state has placeholder anchors, so describing
                // them would assert a schedule we never read. A bar holds the
                // line instead, and reads as loading only during a retry.
                retrying ? (
                  <SettingsDescriptionLoading />
                ) : unresolved ? (
                  <InlineTextSkeleton className="w-40" />
                ) : (
                  cadence.describe(state.preferences)
                )
              }
              control={
                // Unresolved: no switch at all. A switch can only say on or
                // off, and either would claim a value we could not read.
                unresolved ? null : (
                  <ToggleSwitch
                    id={toggleId}
                    label={cadence.label}
                    checked={state.preferences[cadence.field]}
                    disabled={saving}
                    dataTestId={`cloud-digest-toggle-${cadence.field}`}
                    onChange={() => {
                      handleToggle(cadence.field);
                    }}
                  />
                )
              }
            >
              {anchorField ? (
                // Inside its cadence's row: the day belongs to it, and it
                // stays visible but disabled while that cadence is off.
                <SettingsSubRow
                  label={
                    anchorField === 'weeklyAnchorDay' ? 'Day' : 'Day of month'
                  }
                  htmlFor={anchorId}
                  control={
                    <SettingsSelect
                      id={anchorId}
                      options={
                        anchorField === 'weeklyAnchorDay'
                          ? WEEKLY_ANCHOR_SELECT_OPTIONS
                          : MONTHLY_ANCHOR_SELECT_OPTIONS
                      }
                      value={String(
                        unresolved
                          ? DEFAULT_DIGEST_PREFERENCES[anchorField]
                          : state.preferences[anchorField],
                      )}
                      disabled={
                        saving ||
                        unresolved ||
                        !state.preferences[cadence.field]
                      }
                      data-testid={`cloud-digest-anchor-${cadence.field}`}
                      onValueChange={(next) => {
                        handleAnchorChange(anchorField, next);
                      }}
                    />
                  }
                />
              ) : null}
            </SettingsRow>
          );
        })}
        {/* The archive link belongs to the whole section, so it is a row of
            its own rather than a button beside the heading. */}
        <SettingsRow
          label="Past digests"
          description="Read the digests you've received."
          control={
            <Button
              size="compact"
              variant="secondary"
              onClick={handleOpenDigests}
              data-testid="cloud-digests-view-link"
            >
              View in browser
            </Button>
          }
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
