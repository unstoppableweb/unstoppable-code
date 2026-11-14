'use client';
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_CARD_GROUP_CLASS,
  SETTINGS_CARD_SUBTITLE_CLASS,
} from '@canopy/ui-shared/components/settings/SettingsCard';

import { useEffect, useRef, useState, type JSX } from 'react';
import { Lock } from '@canopy/ui-shared/icons/AppIcons';
import {
  ConfirmDialog,
  DataSharingFeaturePills,
  DelayedLoadingPlaceholder,
  ErrorBanner,
  Skeleton,
  Stack,
  Tooltip,
  SettingsSelect,
  FormField,
  SettingsRowsRow,
  ToggleSwitch,
  Heading,
} from '@canopy/ui-shared/components';
import { organizationBillingPath } from '@canopy/protocol/billing';
import {
  DATA_SHARING_PREREQUISITE_SCOPE,
  DATA_SHARING_SCOPE_DESCRIPTIONS,
  DATA_SHARING_SCOPE_LABELS,
  DATA_SHARING_SCOPE_ORDER,
  dataSharingDependencyNote,
  type DataSharingScopeKey,
} from '@canopy/ui-shared/lib';
import type {
  EnforcedSyncScopes,
  EnforcementScopeCoverage,
  OrganizationDetail,
  OrganizationRole,
} from '@canopy/protocol/settings/organization';
import {
  canForceEnableUncoveredScopes,
  ENFORCE_SHARING_CAPABILITY_BY_SCOPE,
  enforcementCoverageFromCapabilities,
  FULL_ENFORCEMENT_COVERAGE,
  isScopeRequired,
  ORGANIZATION_ROLES,
} from '@canopy/protocol/settings/organization';
import { lowestPlanNameWithCapability } from '@canopy/protocol/settings/billing-plan-catalog';
import {
  canEditOrgEnforcedSettings,
  canEditUsageStatsConfig,
  canViewUsageStats,
} from '@canopy/protocol/settings/organization-permissions';
import { useSettingsBrand, useSettingsClient } from '../host';
import { useSettingsErrorCopy } from '../errors';
import { ORGANIZATION_LAPSED_ERROR } from './organization-known-errors';
import {
  getOrgBillingSummary,
  updateAllowExternalContainerSharing,
  updateEnforceMemberDataSharing,
  updateEnforcedSync,
  updateUsageStatsMinRole,
} from './team-api';
import type { SettingsFailure } from '../errors';
import { Surface } from '@canopy/ui-shared/components';

const USAGE_SETTINGS_ERROR_SCOPE = 'settings.organization.usage-settings';

/**
 * Every scope unset — the member's own choice — which is what an org that has
 * never opened this card has. `null`, not `false`: `false` is a prohibition, so
 * defaulting to it would render four locked-off rows for an org with no policy.
 */
const NO_ENFORCED_SYNC: EnforcedSyncScopes = {
  transcripts: null,
  plans: null,
  metadata: null,
  summaries: null,
};

/** Which confirmation is currently open, if any. */
type PendingConfirm = 'enable-enforcement' | 'prohibit-metadata';

interface TeamUsageSettingsSectionProps {
  detail: OrganizationDetail;
  onDetailChange: (detail: OrganizationDetail) => void;
}

const ROLE_LABELS: Record<OrganizationRole, string> = {
  OWNER: 'Owners only',
  ADMIN: 'Admins and owners',
  MEMBER: 'All members',
};

/**
 * Join scope labels the way a sentence needs them ("a and b", "a, b, and c"),
 * not the way `Array.join` does. Only one scope is reachable in today's
 * catalog, but the list is derived from coverage rather than hardcoded, so a
 * tier that withholds two would otherwise read "plans, transcripts".
 */
function formatScopeList(labels: readonly string[]): string {
  if (labels.length <= 1) {
    return labels[0] ?? '';
  }
  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}`;
  }
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

/**
 * Statistics visibility card, self-gated on `canEditUsageStatsConfig`.
 * Rendered independently by `team-page` so the settings tab can order it next
 * to the pricing card that feeds the same dashboard.
 */
export function TeamStatisticsVisibilitySection({
  detail,
  onDetailChange,
}: TeamUsageSettingsSectionProps): JSX.Element | null {
  if (!canEditUsageStatsConfig(detail.viewerRole)) {
    return null;
  }

  return <UsageStatsCard detail={detail} onDetailChange={onDetailChange} />;
}

/**
 * Data sharing card, self-gated on `canEditOrgEnforcedSettings`. Rendered
 * independently by `team-page` so it can sit next to the memory participation
 * card it shares a governance story with.
 */
export function TeamDataSharingSection({
  detail,
  onDetailChange,
}: TeamUsageSettingsSectionProps): JSX.Element | null {
  if (!canEditOrgEnforcedSettings(detail.viewerRole)) {
    return null;
  }

  return (
    <EnforcedSettingsCard detail={detail} onDetailChange={onDetailChange} />
  );
}

/**
 * Owner/admin control for the minimum role required to view the team usage &
 * cost dashboard. Persists `OrganizationConfig.usageStatsMinRole` and updates
 * the in-memory detail so the Statistics tab's visibility re-gates immediately.
 */
function UsageStatsCard({
  detail,
  onDetailChange,
}: TeamUsageSettingsSectionProps): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(USAGE_SETTINGS_ERROR_SCOPE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<SettingsFailure | null>(null);

  const handleChange = async (nextRole: OrganizationRole): Promise<void> => {
    if (nextRole === detail.usageStatsMinRole) {
      return;
    }
    try {
      setSaving(true);
      setError(null);
      const config = await updateUsageStatsMinRole(client, detail.id, nextRole);
      onDetailChange({
        ...detail,
        usageStatsMinRole: config.usageStatsMinRole,
        canViewUsageStats: canViewUsageStats(
          detail.viewerRole,
          config.usageStatsMinRole,
        ),
      });
    } catch (err) {
      setError(
        errorCopy.actionFailure(err, { action: 'update usage visibility' }),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      className={SETTINGS_CARD_CLASS}
      data-testid="team-usage-settings-section"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <Heading level={2} variant="section">
          Statistics
        </Heading>
        <p className={SETTINGS_CARD_SUBTITLE_CLASS}>
          Choose the minimum role that can open the statistics dashboard. It
          only ever shows aggregated counts and cost — never message content.
        </p>
      </div>
      <div className={SETTINGS_CARD_GROUP_CLASS}>
        <Stack gap="item">
          <ErrorBanner
            errorSource="usage-stats-card"
            className=""
            error={error?.copy}
            details={error?.details}
          />
          <FormField
            label="Who can view usage stats"
            dataTestId="usage-min-role-field"
          >
            {(control) => (
              <div className="relative inline-flex max-w-xs">
                <SettingsSelect
                  {...control}
                  value={detail.usageStatsMinRole}
                  disabled={saving}
                  data-testid="usage-min-role-select"
                  onValueChange={(next) => {
                    if (isRole(next)) {
                      void handleChange(next);
                    }
                  }}
                  width="fill"
                  options={ORGANIZATION_ROLES.map((role) => ({
                    value: role,
                    label: ROLE_LABELS[role],
                  }))}
                />
              </div>
            )}
          </FormField>
        </Stack>
      </div>
    </section>
  );
}

/**
 * Owner/admin home for the org's data-sharing policy: which categories of agent
 * activity members may send to the cloud, and which never leave their machines.
 *
 * The master checkbox and the per-scope switches are independent columns on the
 * same config row, so the scopes survive the master being turned off and the
 * admin's configuration comes back intact when it is turned on again.
 */
function EnforcedSettingsCard({
  detail,
  onDetailChange,
}: TeamUsageSettingsSectionProps): JSX.Element {
  const brand = useSettingsBrand();
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(USAGE_SETTINGS_ERROR_SCOPE);
  const [savingKey, setSavingKey] = useState<DataSharingScopeKey | null>(null);
  const [savingMaster, setSavingMaster] = useState(false);
  const [savingExternalSharing, setSavingExternalSharing] = useState(false);
  const [error, setError] = useState<SettingsFailure | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(
    null,
  );
  /**
   * `null` until the billing read resolves, and permanently `null` if it
   * fails — NOT the optimistic default dressed up as an answer.
   *
   * Coverage stopped being a purely cosmetic "is this row editable" input when
   * an uncovered scope started force-enabling: it now decides where the switch
   * SITS and which scopes the enable-enforcement dialog must disclose. An
   * unknown coverage rendered as full coverage is therefore a claim, and it is
   * the claim most likely to be wrong in the under-reporting direction.
   */
  const [coverage, setCoverage] = useState<EnforcementScopeCoverage | null>(
    null,
  );
  /**
   * Held apart from `error` on purpose. A failed plan read is a PERSISTENT
   * condition, and both save paths clear `error` on entry — so sharing one slot
   * means the first toggle silently erases a warning nothing has resolved.
   */
  const [coverageError, setCoverageError] = useState<SettingsFailure | null>(
    null,
  );

  /**
   * Still fail OPEN for editability: the PATCH route rejects a change to an
   * uncovered scope with a 403 either way, so a transient billing read must not
   * lock an entitled admin out of controls they are paying for. What no longer
   * fails silently is the DISCLOSURE — see `coverageError` and the dialog copy.
   */
  const effectiveCoverage = coverage ?? FULL_ENFORCEMENT_COVERAGE;

  /**
   * Whether the billing read has finished, either way. Distinguishes the
   * in-flight window from a failure, which `coverage === null` alone does not.
   *
   * Nothing that states a POSITION renders before this is true. Painting the
   * optimistic fallback while the request is still running would flash a
   * Business org's metadata row as an interactive off switch — "your org is not
   * sharing usage metadata" — which is the precise claim this change exists to
   * remove, and it would be wrong for as long as the request takes.
   */
  const coverageResolved = coverage !== null || coverageError !== null;
  // Bumped by Retry to read the plan again.
  const [coverageAttempt, setCoverageAttempt] = useState(0);

  const orgId = detail.id;
  const enforcing = detail.enforceMemberDataSharing === true;
  const allowExternalSharing = detail.allowExternalContainerSharing === true;
  const enforcedSync = detail.enforcedSync ?? NO_ENFORCED_SYNC;
  // ANY in-flight save freezes the whole card. A per-scope PATCH is a full
  // four-scope replacement, so a second toggle started mid-flight would send the
  // first scope's PRE-toggle value back and silently revert it. The external
  // sharing save is included too: each save spreads the render-time `detail`
  // into `onDetailChange`, so two overlapping saves would revert each other.
  const saving = savingMaster || savingKey !== null || savingExternalSharing;

  /**
   * The configuration the SERVER last confirmed, which is what the next PATCH
   * body is built from. Rebasing on the render-time `enforcedSync` instead would
   * reintroduce the same lost update whenever a response lands before its
   * `onDetailChange` has propagated back down as new props.
   */
  const latestConfigRef = useRef<{
    enforceMemberDataSharing: boolean;
    enforcedSync: EnforcedSyncScopes;
  }>({ enforceMemberDataSharing: enforcing, enforcedSync });

  useEffect(() => {
    latestConfigRef.current = {
      enforceMemberDataSharing: detail.enforceMemberDataSharing === true,
      enforcedSync: detail.enforcedSync ?? NO_ENFORCED_SYNC,
    };
  }, [detail.enforceMemberDataSharing, detail.enforcedSync]);

  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const summary = await getOrgBillingSummary(client, orgId);
        if (!cancelled) {
          setCoverage(
            enforcementCoverageFromCapabilities(summary.capabilities),
          );
        }
      } catch (err) {
        // Leaves `coverage` null — unknown, not "covered". Failing closed would
        // just move the same wrong claim to a different tier, so the honest
        // state is that we don't know, said out loud.
        if (!cancelled) setCoverageError(errorCopy.loadFailure(err));
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [client, orgId, errorCopy, coverageAttempt]);

  /** Retry clears the error, so the card waits on the plan read again. */
  const retryCoverage = (): void => {
    setCoverageError(null);
    setCoverageAttempt((attempt) => attempt + 1);
  };

  const reportError = (err: unknown, action: string): void => {
    setError(
      errorCopy.actionFailure(err, {
        action,
        known: [ORGANIZATION_LAPSED_ERROR],
      }),
    );
  };

  const saveMaster = async (next: boolean): Promise<void> => {
    try {
      setSavingMaster(true);
      setError(null);
      const config = await updateEnforceMemberDataSharing(client, orgId, next);
      latestConfigRef.current = {
        enforceMemberDataSharing: config.enforceMemberDataSharing,
        enforcedSync: config.enforcedSync,
      };
      onDetailChange({
        ...detail,
        enforceMemberDataSharing: config.enforceMemberDataSharing,
        // Adopt the scopes the server actually persisted rather than assuming
        // they are unchanged. A switch-only PATCH deliberately does NOT
        // materialize unset scopes, so they stay `null` here; echoing the
        // response keeps the rows honest either way.
        enforcedSync: config.enforcedSync,
      });
    } catch (err) {
      reportError(err, 'update data sharing');
    } finally {
      setSavingMaster(false);
      // Held open through the save so the confirm button carries the busy state;
      // the error banner behind it is what reports a failure.
      setPendingConfirm(null);
    }
  };

  const saveExternalSharing = async (next: boolean): Promise<void> => {
    try {
      setSavingExternalSharing(true);
      setError(null);
      const config = await updateAllowExternalContainerSharing(
        client,
        orgId,
        next,
      );
      onDetailChange({
        ...detail,
        allowExternalContainerSharing:
          config.allowExternalContainerSharing === true,
      });
    } catch (err) {
      reportError(err, 'update sharing outside the organization');
    } finally {
      setSavingExternalSharing(false);
    }
  };

  const saveScope = async (
    key: DataSharingScopeKey,
    next: boolean,
  ): Promise<void> => {
    const base = latestConfigRef.current;
    const nextEnforced: EnforcedSyncScopes = {
      ...base.enforcedSync,
      [key]: next,
    };
    try {
      setSavingKey(key);
      setError(null);
      const config = await updateEnforcedSync(
        client,
        orgId,
        nextEnforced,
        base.enforceMemberDataSharing,
      );
      latestConfigRef.current = {
        enforceMemberDataSharing: config.enforceMemberDataSharing,
        enforcedSync: config.enforcedSync,
      };
      onDetailChange({
        ...detail,
        enforceMemberDataSharing: config.enforceMemberDataSharing,
        enforcedSync: config.enforcedSync,
      });
    } catch (err) {
      reportError(err, 'update data sharing');
    } finally {
      setSavingKey(null);
      setPendingConfirm(null);
    }
  };

  const handleMasterChange = (next: boolean): void => {
    // Turning enforcement ON overrides every member's own choice on their own
    // machine, so it confirms. Turning it off only hands the choice back.
    if (next) {
      setPendingConfirm('enable-enforcement');
      return;
    }
    void saveMaster(false);
  };

  const handleScopeChange = (key: DataSharingScopeKey, next: boolean): void => {
    // Usage metadata is the prerequisite scope: prohibiting it also silences
    // every scope that depends on it. The other three are the intended privacy
    // actions with a bounded, stated cost, and confirming those too would train
    // admins to click straight through the one dialog that matters.
    if (key === DATA_SHARING_PREREQUISITE_SCOPE && !next) {
      setPendingConfirm('prohibit-metadata');
      return;
    }
    void saveScope(key, next);
  };

  const metadataProhibited =
    enforcedSync[DATA_SHARING_PREREQUISITE_SCOPE] === false;

  // Scopes that turning enforcement ON would force-enable: uncovered, not
  // already blocked, and only when the plan force-enables at all. Empty for an
  // org whose plan covers everything, and for one that enforces nothing.
  const forcedScopes = DATA_SHARING_SCOPE_ORDER.filter(
    (key) =>
      !effectiveCoverage[key] &&
      isScopeRequired(enforcedSync[key], key, effectiveCoverage),
  ).map((key) => DATA_SHARING_SCOPE_LABELS[key].toLowerCase());

  /**
   * The disclosure the enable-enforcement dialog owes the admin.
   *
   * A FAILED read is its own branch rather than folding into "nothing forced".
   * An unread plan produces an EMPTY forced list, so without this the dialog
   * would quietly drop the sentence in exactly the case where the admin has the
   * least idea what they are agreeing to — and the server will still
   * force-enable on save.
   *
   * Keyed on `coverageError`, not on `coverage === null`, because `null` also
   * covers the in-flight window — and telling an admin the plan couldn't be
   * read while the request is still running is its own false statement. The
   * checkbox is disabled until coverage resolves, so that window cannot reach
   * this dialog at all.
   */
  const forcedScopeDisclosure =
    coverageError !== null
      ? " We couldn't load these settings, so some categories may be turned on for everyone."
      : forcedScopes.length > 0
        ? ` Your plan can't turn off ${formatScopeList(forcedScopes)}, so ${forcedScopes.length === 1 ? 'it stays' : 'those stay'} on for everyone.`
        : '';

  return (
    <section
      className={SETTINGS_CARD_CLASS}
      data-testid="team-enforced-settings-section"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <Heading level={2} variant="section">
          Data sharing
        </Heading>
        <p className={SETTINGS_CARD_SUBTITLE_CLASS}>
          {`Choose what agent activity members may share with ${brand.displayName} from this organization's work. Anything turned off here is not shared. Usage counts are set under Member usage data. Personal work follows each member's own settings.`}
        </p>
      </div>
      <div className={SETTINGS_CARD_GROUP_CLASS}>
        <Stack gap="group">
          {(error || coverageError) && (
            <Stack gap="item">
              <ErrorBanner
                errorSource="enforced-settings-card"
                className=""
                error={error?.copy}
                details={error?.details}
              />
              {/* Keep plan-read failures visible when a save clears its own error. */}
              <ErrorBanner
                errorSource="enforced-settings-card-coverage"
                className=""
                error={coverageError?.copy}
                details={coverageError?.details}
                onRetry={retryCoverage}
              />
            </Stack>
          )}
          <SettingsRowsRow
            label="Enforce member data sharing policy"
            description="Members use this organization's settings instead of their own."
            control={
              <ToggleSwitch
                label="Enforce member data sharing policy"
                checked={enforcing}
                /*
                 * Also held until coverage resolves, so the confirm dialog
                 * can never be opened in the one state where it cannot say
                 * which scopes turning this on would force on.
                 */
                disabled={saving || !coverageResolved}
                dataTestId="enforce-member-data-sharing-checkbox"
                onChange={handleMasterChange}
              />
            }
          />

          {enforcing && !coverageResolved ? (
            <div data-testid="enforced-sync-coverage-pending">
              <DelayedLoadingPlaceholder>
                <DataSharingScopesSkeleton orgId={orgId} />
              </DelayedLoadingPlaceholder>
            </div>
          ) : null}

          {enforcing && coverageResolved ? (
            <Surface variant="outline" className="overflow-hidden">
              <ul className="flex flex-col gap-4 p-4">
                {DATA_SHARING_SCOPE_ORDER.map((key) => (
                  <DataSharingScopeRow
                    key={key}
                    scope={key}
                    value={enforcedSync[key]}
                    coverage={effectiveCoverage}
                    busy={saving}
                    orgId={orgId}
                    metadataProhibited={metadataProhibited}
                    onChange={handleScopeChange}
                  />
                ))}
              </ul>
            </Surface>
          ) : null}

          <SettingsRowsRow
            label="Allow sharing outside the organization"
            description="Members can share worktrees and Cowork work by email with people outside this organization."
            control={
              <ToggleSwitch
                label="Allow sharing outside the organization"
                checked={allowExternalSharing}
                // Independent of plan coverage, so only an in-flight save
                // holds it.
                disabled={saving}
                dataTestId="allow-external-container-sharing-checkbox"
                onChange={(next) => void saveExternalSharing(next)}
              />
            }
          />
        </Stack>
      </div>

      {pendingConfirm === 'enable-enforcement' ? (
        <ConfirmDialog
          title="Enforce data sharing policy for all members?"
          /*
           * The second sentence is the disclosure this dialog owes the admin.
           * Enabling enforcement does not only apply the policy they can see -
           * on a plan that doesn't cover every category, the ones it doesn't
           * cover turn ON for every member. Someone enabling this specifically
           * to block transcripts would otherwise force-share usage metadata
           * without ever being told.
           */
          message={`Each member follows the data sharing policy defined by your organization. They can see the policy but not change it.${forcedScopeDisclosure}`}
          confirmLabel="Enforce"
          busyLabel="Saving…"
          busy={savingMaster}
          dataTestId="enforce-member-data-sharing-confirm-dialog"
          confirmTestId="enforce-member-data-sharing-confirm"
          onCancel={() => setPendingConfirm(null)}
          onConfirm={() => void saveMaster(true)}
        />
      ) : null}

      {pendingConfirm === 'prohibit-metadata' ? (
        <ConfirmDialog
          title={`Block ${DATA_SHARING_SCOPE_LABELS.metadata}?`}
          message="Most of Timeline, all of Statistics, member profiles, leaderboards, and push notifications stop working, and every other category here stops uploading because they all depend on it."
          confirmLabel="Block"
          busyLabel="Saving…"
          busy={savingKey === DATA_SHARING_PREREQUISITE_SCOPE}
          destructive
          dataTestId="prohibit-metadata-confirm-dialog"
          confirmTestId="prohibit-metadata-confirm"
          onCancel={() => setPendingConfirm(null)}
          onConfirm={() =>
            void saveScope(DATA_SHARING_PREREQUISITE_SCOPE, false)
          }
        />
      ) : null}
    </section>
  );
}

const noop = (): void => undefined;

/** Sample scopes for the loading state: the first two rows, all covered. */
const SAMPLE_SCOPES: readonly DataSharingScopeKey[] = ['metadata', 'plans'];
const SAMPLE_COVERAGE: EnforcementScopeCoverage = {
  metadata: true,
  plans: true,
  summaries: true,
  transcripts: true,
};

/**
 * The scope list while plan coverage loads: the real rows with sample scopes
 * inside `Skeleton`, so skullet measures them into bars in place.
 */
function DataSharingScopesSkeleton({ orgId }: { orgId: string }): JSX.Element {
  return (
    <Skeleton
      loading
      label="Loading data sharing settings"
      testId="settings-skeleton-form"
      className="w-full"
    >
      <Surface variant="outline" className="overflow-hidden">
        <ul className="flex flex-col gap-4 p-4">
          {SAMPLE_SCOPES.map((scope) => (
            <DataSharingScopeRow
              key={scope}
              scope={scope}
              value
              coverage={SAMPLE_COVERAGE}
              busy={false}
              orgId={orgId}
              metadataProhibited={false}
              onChange={noop}
            />
          ))}
        </ul>
      </Surface>
    </Skeleton>
  );
}

interface DataSharingScopeRowProps {
  scope: DataSharingScopeKey;
  /** Stored three-state value: required / prohibited / unset. */
  value: boolean | null;
  /**
   * The org's WHOLE coverage map, not just this scope's bit: whether an
   * uncovered scope force-enables depends on the org holding some other
   * enforcement capability, so `isScopeRequired` needs all four.
   */
  coverage: EnforcementScopeCoverage;
  /** True while ANY save on the card is in flight, not just this row's. */
  busy: boolean;
  orgId: string;
  /** Whether the prerequisite scope is explicitly prohibited. */
  metadataProhibited: boolean;
  onChange: (scope: DataSharingScopeKey, next: boolean) => void;
}

interface LockedScopeCopy {
  /** Hover explanation carried by the switch's tooltip. */
  tooltip: string;
  /** Parenthetical folded into the switch's accessible name. */
  switchState: string;
  /** The tooltip's CTA, naming the tier that unlocks the row. */
  upgradeText: string;
}

/**
 * Where an uncovered scope actually sits, in the admin's terms.
 *
 * A scope the plan does not cover is not a scope the admin has an opinion about
 * yet - it is a scope they are not entitled to turn OFF, and `isScopeRequired`
 * (`lib/teams/types.ts`) genuinely projects it as required for every
 * member. So it renders force-enabled: switch on, locked, upgrade path
 * attached. This row and that projection have to keep agreeing; a row that
 * reads "each member chooses" while the server pins the scope on is the exact
 * mismatch this copy was rewritten to close.
 *
 * The one exception is a surviving prohibition, which the same function carves
 * out: a block an org set while entitled still applies after a downgrade,
 * because rolling it back would resume uploading data the org explicitly said
 * not to upload. That row reads blocked, and saying otherwise would be a
 * privacy claim that is simply false.
 *
 * None of this renders in the row - the row is its description and nothing
 * else - so all three strings are derived here together, keeping the tooltip,
 * its CTA, and the switch's accessible name from ever disagreeing about the
 * same row.
 */
function lockedScopeCopy(
  value: boolean | null,
  label: string,
  requiredPlanName: string | null,
  forceEnabled: boolean,
): LockedScopeCopy {
  const lower = label.toLowerCase();
  // The CTA carries the tier so the sentence above it does not have to. Saying
  // "upgrade" in both is the shape this tooltip keeps drifting back into.
  const upgradeText = requiredPlanName
    ? `Upgrade to ${requiredPlanName}`
    : 'Upgrade';

  if (value === false) {
    // Prohibitions survive a downgrade, so this one is still enforced.
    //
    // The label is deliberately NOT the sentence subject: three of the four are
    // plural ("Plans", "Transcripts", "Session summaries"), so `${label} is
    // blocked` reads "Plans is blocked" for everything except usage metadata.
    return {
      tooltip: `Your plan no longer includes this policy, but ${lower} stays blocked for every member.`,
      switchState: "blocked; your plan can't change it",
      upgradeText,
    };
  }

  if (forceEnabled) {
    return {
      tooltip: `Your plan doesn't support turning off ${lower} sharing.`,
      switchState: 'always on for your plan',
      upgradeText,
    };
  }

  // The org holds no enforcement capability at all, so nothing here is
  // enforced in either direction and each member keeps their own setting.
  // Claiming the sharing is on would be the same over-claim in a plan tier
  // where it happens not to be true - see `canForceEnableUncoveredScopes`.
  return {
    tooltip: `Your plan doesn't include a data sharing policy, so each member chooses ${lower} for themselves.`,
    switchState: 'not included in your plan; each member chooses',
    upgradeText,
  };
}

/**
 * One scope row: its label and disclosure, the required/blocked switch, the
 * feature pills stating what the current position costs, and the dependency
 * note that keeps the policy honest.
 */
function DataSharingScopeRow({
  scope,
  value,
  coverage,
  busy,
  orgId,
  metadataProhibited,
  onChange,
}: DataSharingScopeRowProps): JSX.Element {
  const covered = coverage[scope];
  // The SAME predicate the server projects enforcement with, so the switch
  // position cannot disagree with what members actually get. Covered rows read
  // the stored value; uncovered rows read force-enabled unless a prohibition
  // survived a downgrade or the org holds no enforcement capability at all.
  const sharing = isScopeRequired(value, scope, coverage);
  const label = DATA_SHARING_SCOPE_LABELS[scope];
  // Derived once so the tooltip and the switch's accessible name always describe
  // the same row the same way.
  const lockedCopy = lockedScopeCopy(
    value,
    label,
    lowestPlanNameWithCapability(ENFORCE_SHARING_CAPABILITY_BY_SCOPE[scope]),
    canForceEnableUncoveredScopes(coverage),
  );
  // Strictly `=== false`: an unset prerequisite is the member's own choice, so
  // claiming a dependent scope is silently broken would be a guess.
  const showDependencyNote =
    metadataProhibited && scope !== DATA_SHARING_PREREQUISITE_SCOPE && sharing;

  return (
    <li
      className="flex flex-col gap-2"
      data-testid={`enforced-sync-row-${scope}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-s font-medium fg-primary">{label}</p>
          <p className="text-xs fg-secondary">
            {DATA_SHARING_SCOPE_DESCRIPTIONS[scope]}
          </p>
        </div>
        {covered ? (
          <ToggleSwitch
            checked={sharing}
            label={`Share ${label}`}
            dataTestId={`enforced-sync-toggle-${scope}`}
            disabled={busy}
            onChange={(next) => onChange(scope, next)}
          />
        ) : (
          <Tooltip
            label={
              <span className="block max-w-64 whitespace-normal">
                {lockedCopy.tooltip}
              </span>
            }
            link={{
              href: organizationBillingPath(orgId),
              text: lockedCopy.upgradeText,
              external: false,
            }}
          >
            {/*
             * The lock glyph lives inside the tooltip trigger so the most
             * obvious "why is this locked?" affordance shares one hover target
             * with the switch.
             *
             * `aria-disabled` rather than the native `disabled` attribute: a
             * natively disabled button leaves the tab order and fires no hover
             * events, so the explanation would be unreachable. Note this only
             * buys back hover and focus on the trigger - the Upgrade link
             * *inside* the tooltip is still not keyboard reachable, because
             * `Tooltip` portals its content to `document.body` and tabbing off
             * this switch blurs the wrapper and unmounts the tooltip first. The
             * always-visible `Upgrade` link beneath the row is the accessible
             * path; this tooltip is supplementary.
             */}
            <span className="flex shrink-0 items-center gap-2">
              <Lock size={12} aria-hidden="true" className="fg-secondary/70" />
              <ToggleSwitch
                checked={sharing}
                label={`Share ${label} (${lockedCopy.switchState})`}
                dataTestId={`enforced-sync-toggle-${scope}`}
                unavailable
                onChange={() => undefined}
              />
            </span>
          </Tooltip>
        )}
      </div>

      {/*
       * Every row is title, description, pills - the same three parts in the
       * same order whether or not the plan covers the scope. Coverage changes
       * the switch and nothing else, so the four rows stay scannable as one
       * list. The locked state lives entirely in the lock glyph, the dimmed
       * switch, the switch's accessible name, and the tooltip.
       */}
      <DataSharingFeaturePills
        scope={scope}
        sharing={sharing}
        dataTestId={`enforced-sync-pills-${scope}`}
      />

      {showDependencyNote ? (
        <p
          className="text-xs fg-warning"
          data-testid={`enforced-sync-dependency-${scope}`}
        >
          {dataSharingDependencyNote(scope)}
        </p>
      ) : null}
    </li>
  );
}

function isRole(value: string): value is OrganizationRole {
  return value === 'OWNER' || value === 'ADMIN' || value === 'MEMBER';
}
