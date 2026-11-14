'use client';

import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { ReactNode } from 'react';
import { ErrorBanner, SettingsSelect } from '@canopy/ui-shared/components';
import {
  DIGEST_WEEKDAY_LABELS,
  digestOrdinalDay,
  parseDigestPreferences,
} from '@canopy/protocol/digests';
import {
  SETTINGS_CARD_ROW_CLASS,
  SettingsCard,
  SettingsCardSwitch,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import {
  DEFAULT_DIGEST_PREFERENCES,
  DIGEST_CADENCES,
  type DigestPreferencesValue,
} from './digest-format';
import { SettingsOperationError } from '@canopy/protocol/settings';
import {
  SETTINGS_LOAD_ERROR_COPY,
  useSettingsErrorCopy,
  type SettingsFailure,
} from '../errors';
import { useSettingsClient } from '../host';
import {
  ACCOUNT_DIGEST_OWNER,
  readDigestPreferences,
  updateDigestPreferences,
  type DigestOwner,
} from './digest-api';
import { Divider } from '@canopy/ui-shared/components';

const SAVE_ACTION = 'save digest settings';
const SAVE_ERROR_COPY = `Couldn't ${SAVE_ACTION}. Try again.`;

/** A failed read offers Retry; a failed save is retried by saving again. */
interface PreferencesError extends SettingsFailure {
  readonly retryLoad: boolean;
}

const WEEKLY_ANCHOR_OPTIONS: readonly number[] = [1, 2, 3, 4, 5, 6, 7];
const MONTHLY_ANCHOR_OPTIONS: readonly number[] = Array.from(
  { length: 31 },
  (_, index) => index + 1,
);

export interface DigestPreferencesCardProps {
  /**
   * Whose preferences these are. The account owner reads and writes
   * `account.notifications.digestPreferences.*`; an organization reads and
   * writes `organization.digests.preferences*`. That is what lets the account
   * and organization cards be the same component.
   */
  owner: DigestOwner;
  title: string;
  description: string;
  /** Distinguishes the account and org instances for automation selectors. */
  testIdPrefix: string;
  /** Optional trailing content, e.g. a link to the digest archive. */
  footer?: ReactNode;
}

/**
 * Reads a preferences payload defensively. The routes return the projected
 * preference object, but a flag-off deploy answers 404 with a different shape
 * and we must not coerce that into "all cadences off".
 *
 * This delegates to the shared narrower instead of re-implementing it. The
 * local copy this replaced dropped every key it did not know about, which would
 * have silently discarded the anchors on read and then omitted them from the
 * PATCH body — resetting the user's anchor on the next toggle.
 */
function parsePreferences(value: unknown): DigestPreferencesValue | null {
  return parseDigestPreferences(value);
}

/**
 * The surface does not exist for this viewer: the flag is off (404) or org
 * edit rights were revoked (403).
 */
function isUnavailable(error: unknown): boolean {
  return (
    error instanceof SettingsOperationError &&
    (error.status === 404 || error.status === 403)
  );
}

/**
 * The three digest cadence toggles for one subject (a user or an organization).
 *
 * Self-gating is deliberate and is why no `digestsEnabled` prop is threaded
 * down from the server: every digest route is wrapped in `requireDigestsEnabled`
 * and answers 404 while the `canopy-digests-enabled` flag is off. A 404 here
 * therefore means "this surface does not exist yet", and the card renders
 * nothing — which keeps the flag's single source of truth on the server instead
 * of duplicating it through six organization page components.
 */
export function DigestPreferencesCard({
  owner,
  title,
  description,
  testIdPrefix,
  footer,
}: DigestPreferencesCardProps): JSX.Element | null {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy('digests');
  // The load effect keys on the owner's identity, not the object, so a parent
  // that rebuilds `owner` each render does not refetch.
  const organizationId =
    owner.kind === 'organization' ? owner.organizationId : null;
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  // Whether `preferences` actually came from the server. Until it does it holds
  // placeholder defaults, and toggling from those would PATCH weekly-on back as
  // if the user had chosen it — silently rewriting settings we failed to read.
  const [resolved, setResolved] = useState(false);
  const [preferences, setPreferences] = useState<DigestPreferencesValue>(
    DEFAULT_DIGEST_PREFERENCES,
  );
  const [savingField, setSavingField] = useState<string | null>(null);
  const [error, setError] = useState<PreferencesError | null>(null);
  // Bumped by Retry to read the preferences again.
  const [loadAttempt, setLoadAttempt] = useState(0);
  // Guards against a slow PATCH resolving after the component unmounts, and
  // against two rapid toggles racing each other's rollback.
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const loadOwner: DigestOwner =
      organizationId === null
        ? ACCOUNT_DIGEST_OWNER
        : { kind: 'organization', organizationId };
    const load = async (): Promise<void> => {
      try {
        const result = await readDigestPreferences(client, loadOwner);
        if (!active) return;
        const parsed = parsePreferences(result);
        if (parsed) {
          setPreferences(parsed);
          setResolved(true);
          setError(null);
        } else {
          setError({ copy: SETTINGS_LOAD_ERROR_COPY, retryLoad: true });
        }
      } catch (loadError) {
        if (!active) return;
        if (isUnavailable(loadError)) {
          setAvailable(false);
          return;
        }
        setError({ ...errorCopy.loadFailure(loadError), retryLoad: true });
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return (): void => {
      active = false;
    };
  }, [client, errorCopy, loadAttempt, organizationId]);

  const retryLoad = useCallback((): void => {
    setError(null);
    setLoadAttempt((attempt) => attempt + 1);
  }, []);

  const save = useCallback(
    async (next: DigestPreferencesValue, savingKey: string): Promise<void> => {
      // Only a server-resolved value is safe to write from; see `resolved`.
      if (!resolved) return;
      const previous = preferences;
      setPreferences(next);
      setSavingField(savingKey);
      setError(null);
      try {
        const result = await updateDigestPreferences(client, owner, next);
        if (!mounted.current) return;
        // The route returns the full preference object, so replace state
        // wholesale rather than trusting the optimistic value.
        const parsed = parsePreferences(result);
        if (!parsed) {
          // Treat an unreadable body exactly as the load path does, instead of
          // showing the optimistic value as though it had been persisted.
          setPreferences(previous);
          setError({ copy: SAVE_ERROR_COPY, retryLoad: false });
          return;
        }
        setPreferences(parsed);
      } catch (saveError) {
        if (!mounted.current) return;
        // Same contract the load path honors: the surface no longer exists for
        // this viewer (flag flipped off, or org edit rights revoked in another
        // tab), so hide the card rather than leaving toggles that report
        // "unable to save" on every future click.
        if (isUnavailable(saveError)) {
          setAvailable(false);
          return;
        }
        setPreferences(previous);
        setError({
          ...errorCopy.actionFailure(saveError, { action: SAVE_ACTION }),
          retryLoad: false,
        });
      } finally {
        if (mounted.current) setSavingField(null);
      }
    },
    [client, errorCopy, owner, preferences, resolved],
  );

  const handleToggle = useCallback(
    (field: 'daily' | 'weekly' | 'monthly'): void => {
      void save({ ...preferences, [field]: !preferences[field] }, field);
    },
    [preferences, save],
  );

  const handleAnchorChange = useCallback(
    (field: 'weeklyAnchorDay' | 'monthlyAnchorDay', rawValue: string): void => {
      const parsedValue = Number.parseInt(rawValue, 10);
      if (!Number.isInteger(parsedValue)) return;
      void save({ ...preferences, [field]: parsedValue }, field);
    },
    [preferences, save],
  );

  if (!available) return null;
  // Render nothing until the first GET resolves. With the flag off the route
  // answers 404 and this card disappears, but only after the round trip — so
  // rendering eagerly would flash an unreleased feature's title, copy, and a
  // "View past digests" link pointing at a page that calls `notFound()`.
  if (loading) return null;

  return (
    <SettingsCard
      title={title}
      subtitle={description}
      testId={`${testIdPrefix}-digest-preferences`}
    >
      <ErrorBanner
        errorSource="digest-preferences-card"
        error={error?.copy}
        details={error?.details}
        onRetry={error?.retryLoad === true ? retryLoad : undefined}
      />

      <ul className="flex flex-col">
        {DIGEST_CADENCES.map((cadence) => {
          const checked = preferences[cadence.field];
          const anchorField =
            cadence.field === 'weekly'
              ? 'weeklyAnchorDay'
              : cadence.field === 'monthly'
                ? 'monthlyAnchorDay'
                : null;
          return (
            <li key={cadence.key} className={SETTINGS_CARD_ROW_CLASS}>
              <div className="min-w-0 flex flex-col gap-2">
                <div>
                  <p className="text-s font-medium fg-primary">
                    {cadence.label}
                  </p>

                  <p className="text-xs fg-secondary">
                    {cadence.describe(preferences)}
                  </p>
                </div>

                {anchorField && (
                  <div className="flex items-center gap-2 text-xs fg-secondary">
                    {/* The dropdown carries its own name; this is its visible
                        lead-in. */}
                    <span aria-hidden="true">
                      {anchorField === 'weeklyAnchorDay'
                        ? 'Send on'
                        : 'Send on day'}
                    </span>
                    <SettingsSelect
                      value={String(preferences[anchorField])}
                      // Unresolved state carries placeholder anchors, so writing
                      // from it would persist a value the user never chose —
                      // the same hazard the toggles guard against.
                      disabled={savingField !== null || !resolved}
                      aria-label={`${cadence.label} digest anchor`}
                      data-testid={`${testIdPrefix}-digest-anchor-${cadence.field}`}
                      onValueChange={(value) =>
                        handleAnchorChange(anchorField, value)
                      }
                      options={
                        anchorField === 'weeklyAnchorDay'
                          ? WEEKLY_ANCHOR_OPTIONS.map((day) => ({
                              value: String(day),
                              label: DIGEST_WEEKDAY_LABELS[day - 1],
                            }))
                          : MONTHLY_ANCHOR_OPTIONS.map((day) => ({
                              value: String(day),
                              label: digestOrdinalDay(day),
                            }))
                      }
                    />
                  </div>
                )}
              </div>
              <SettingsCardSwitch
                // Only a server-read value paints as on, so the announced and
                // painted state cannot claim a preference not read yet.
                checked={checked && resolved}
                busy={!resolved}
                label={`${cadence.label} digest`}
                disabled={savingField !== null || !resolved}
                dataTestId={`${testIdPrefix}-digest-toggle-${cadence.field}`}
                onChange={() => handleToggle(cadence.field)}
              />
            </li>
          );
        })}
      </ul>

      {footer ? (
        <div>
          <Divider />
          <div className="py-3">{footer}</div>
        </div>
      ) : null}
    </SettingsCard>
  );
}
