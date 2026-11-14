'use client';

import { useCallback, useEffect, useState, type JSX } from 'react';
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_CARD_GROUP_CLASS,
  SETTINGS_CARD_SUBTITLE_CLASS,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import {
  ConfirmDialog,
  DelayedLoadingPlaceholder,
  ErrorBanner,
  Heading,
  SettingsRowsGroup,
  SettingsRowsRow,
  Skeleton,
  ToggleSwitch,
} from '@canopy/ui-shared/components';
import type {
  OrganizationConfigDetail,
  OrganizationDetail,
} from '@canopy/protocol/settings/organization';
import { canEditOrgEnforcedSettings } from '@canopy/protocol/settings/organization-permissions';
import { useSettingsBrand, useSettingsClient } from '../host';
import { useSettingsErrorCopy, type SettingsFailure } from '../errors';
import { ORGANIZATION_LAPSED_ERROR } from './organization-known-errors';
import {
  getOrganizationConfig,
  updateMemberUsageDataPolicy,
  type MemberUsageDataPolicyField,
} from './team-api';

const MEMBER_USAGE_DATA_ERROR_SCOPE = 'settings.organization.member-usage-data';

interface MemberUsageDataRow {
  readonly field: MemberUsageDataPolicyField;
  /** Row label, naming the flow the switch keeps on. */
  readonly label: string;
  readonly description: string;
  /** What members stop sending, for the confirm dialog ("… will stop sending …"). */
  readonly stops: string;
}

// Each switch reads ON while members may send the flow, matching the member's
// own Usage data switches; turning one off prohibits it.
const MEMBER_USAGE_DATA_ROWS: readonly MemberUsageDataRow[] = [
  {
    field: 'prohibitMemberProductAnalytics',
    label: 'Usage analytics',
    description: 'Which features members use and how the app performs.',
    stops: 'usage analytics',
  },
  {
    field: 'prohibitMemberSessionReplay',
    label: 'Session recordings',
    description: 'Replays of how members move through the app.',
    stops: 'session recordings',
  },
  {
    field: 'prohibitMemberErrorReports',
    label: 'Error reports',
    description: 'Details of crashes and errors so they can be fixed.',
    stops: 'error reports',
  },
  {
    field: 'prohibitMemberActiveUseSignal',
    label: 'Active use count',
    description: 'A count of the messages members send, never their content.',
    stops: 'their active use count',
  },
  {
    field: 'prohibitMemberFeatureFlagIdentity',
    label: 'Personalized feature rollouts',
    description:
      'Member account details used to decide which new features they get. When off, only the app version and organization are used.',
    stops: 'account details for feature rollouts',
  },
];

type MemberUsageDataPolicy = Record<MemberUsageDataPolicyField, boolean>;

/** Absent fields (an older server) read as not prohibited. */
function policyFromConfig(
  config: OrganizationConfigDetail,
): MemberUsageDataPolicy {
  return {
    prohibitMemberProductAnalytics:
      config.prohibitMemberProductAnalytics === true,
    prohibitMemberErrorReports: config.prohibitMemberErrorReports === true,
    prohibitMemberSessionReplay: config.prohibitMemberSessionReplay === true,
    prohibitMemberActiveUseSignal:
      config.prohibitMemberActiveUseSignal === true,
    prohibitMemberFeatureFlagIdentity:
      config.prohibitMemberFeatureFlagIdentity === true,
  };
}

interface PendingChange {
  readonly row: MemberUsageDataRow;
  readonly prohibited: boolean;
}

interface MemberUsageDataCardProps {
  detail: OrganizationDetail;
}

/**
 * Owner/admin control that turns usage-data flows off for members' desktop
 * app while they work in this organization (mobile is not affected). It only
 * narrows: an allowed flow still follows each member's own choice. No plan
 * gate, and independent of the data sharing policy. Each change confirms
 * first, because it reaches every member.
 */
export function MemberUsageDataCard({
  detail,
}: MemberUsageDataCardProps): JSX.Element | null {
  if (!canEditOrgEnforcedSettings(detail.viewerRole)) {
    return null;
  }
  return <MemberUsageDataCardBody detail={detail} />;
}

function MemberUsageDataCardBody({
  detail,
}: MemberUsageDataCardProps): JSX.Element {
  const brand = useSettingsBrand();
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(MEMBER_USAGE_DATA_ERROR_SCOPE);
  const [policy, setPolicy] = useState<MemberUsageDataPolicy | null>(null);
  const [loadError, setLoadError] = useState<SettingsFailure | null>(null);
  const [error, setError] = useState<SettingsFailure | null>(null);
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [saving, setSaving] = useState(false);
  // Bumped by Retry to read the config again.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const orgId = detail.id;

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    getOrganizationConfig(client, orgId)
      .then((config) => {
        if (!cancelled) {
          setPolicy(policyFromConfig(config));
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(errorCopy.loadFailure(err));
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, [client, orgId, errorCopy, loadAttempt]);

  const retryLoad = useCallback((): void => {
    setLoadAttempt((attempt) => attempt + 1);
  }, []);

  const save = async (change: PendingChange): Promise<void> => {
    const previous = policy;
    try {
      setSaving(true);
      setError(null);
      // Optimistic: the switch moves as the dialog closes, and a failure
      // rolls it back beside the error.
      setPolicy((current) =>
        current ? { ...current, [change.row.field]: change.prohibited } : null,
      );
      const config = await updateMemberUsageDataPolicy(
        client,
        orgId,
        change.row.field,
        change.prohibited,
      );
      setPolicy(policyFromConfig(config));
    } catch (err) {
      setPolicy(previous);
      setError(
        errorCopy.actionFailure(err, {
          action: 'update member usage data',
          known: [ORGANIZATION_LAPSED_ERROR],
        }),
      );
    } finally {
      setSaving(false);
      setPending(null);
    }
  };

  const dialogMessage = pending
    ? pending.prohibited
      ? `Members of ${detail.name} will stop sending ${pending.row.stops} from the ${brand.displayName} desktop app while they work in this organization. They can't turn it back on.`
      : `Members of ${detail.name} can choose again whether to send ${pending.row.stops} while they work in this organization.`
    : '';

  return (
    <section
      className={SETTINGS_CARD_CLASS}
      data-testid="team-member-usage-data-section"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <Heading level={2} variant="section">
          Member usage data
        </Heading>
        <p className={SETTINGS_CARD_SUBTITLE_CLASS}>
          {`Turn off what members' ${brand.displayName} desktop app sends while they work in this organization. Anything left on follows each member's own choice. The mobile app is not affected, and desktop versions released before this setting ignore it until members update.`}
        </p>
      </div>
      <div className={SETTINGS_CARD_GROUP_CLASS}>
        <div className="flex flex-col gap-3">
          <ErrorBanner
            errorSource="member-usage-data-card-body-load"
            error={loadError?.copy}
            details={loadError?.details}
            onRetry={retryLoad}
          />
          <ErrorBanner
            errorSource="member-usage-data-card-body"
            error={error?.copy}
            details={error?.details}
          />
          <div>
            {policy ? (
              // The card's group is already the box, so the rows are split by
              // hairlines with no box of their own.
              <SettingsRowsGroup
                surface="plain"
                dataTestId="member-usage-data-rows"
              >
                {MEMBER_USAGE_DATA_ROWS.map((row) => (
                  <SettingsRowsRow
                    key={row.field}
                    label={row.label}
                    description={row.description}
                    control={
                      <ToggleSwitch
                        label={row.label}
                        checked={!policy[row.field]}
                        disabled={saving}
                        dataTestId={`member-usage-data-${row.field}`}
                        onChange={(allowed): void =>
                          setPending({ row, prohibited: !allowed })
                        }
                      />
                    }
                  />
                ))}
              </SettingsRowsGroup>
            ) : loadError ? null : (
              <DelayedLoadingPlaceholder>
                <Skeleton
                  loading
                  label="Loading member usage data"
                  testId="settings-skeleton-form"
                  className="w-full"
                >
                  <SettingsRowsGroup surface="plain">
                    {MEMBER_USAGE_DATA_ROWS.slice(0, 2).map((row) => (
                      <SettingsRowsRow
                        key={row.field}
                        label={row.label}
                        description={row.description}
                      />
                    ))}
                  </SettingsRowsGroup>
                </Skeleton>
              </DelayedLoadingPlaceholder>
            )}
          </div>
        </div>
      </div>

      {pending ? (
        <ConfirmDialog
          title={
            pending.prohibited
              ? `Turn off ${pending.row.label.toLowerCase()} for members?`
              : `Let members choose ${pending.row.label.toLowerCase()}?`
          }
          message={dialogMessage}
          confirmLabel={pending.prohibited ? 'Turn off' : 'Allow'}
          busyLabel="Saving…"
          busy={saving}
          dataTestId="member-usage-data-confirm-dialog"
          confirmTestId="member-usage-data-confirm"
          onCancel={() => setPending(null)}
          onConfirm={() => void save(pending)}
        />
      ) : null}
    </section>
  );
}
