'use client';
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_CARD_GROUP_CLASS,
  SETTINGS_CARD_SUBTITLE_CLASS,
  SETTINGS_CARD_ROW_CLASS,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import { useCallback, useEffect, useState, type JSX } from 'react';
import {
  Button,
  DelayedLoadingPlaceholder,
  EmptyState,
  ErrorBanner,
  Skeleton,
  TextInput,
  Heading,
} from '@canopy/ui-shared/components';
import type { SubscriptionPlanPricingRow } from '@canopy/protocol/telemetry';
import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import type { OrganizationDetail } from '@canopy/protocol/settings/organization';
import { useSettingsClient } from '../../host';
import { useSettingsErrorCopy, useSettingsLoadFailure } from '../../errors';
import {
  getSubscriptionPlanPricing,
  setSubscriptionPlanPriceOverride,
} from '../team-api';
import { USAGE_KNOWN_LOAD_ERRORS } from '../statistics/usage-error-copy';

/** Logger scope for the plan pricing table. */
const PRICING_ERROR_SCOPE = 'settings.organization.plan-pricing';
import { formatUsd } from '../statistics/format';
import { formatProviderLabel } from '../statistics/run-display';
import type { SettingsFailure } from '../../errors';

interface TeamSubscriptionPricingSectionProps {
  detail: OrganizationDetail;
}

/**
 * Org-settings table of the subscription plan types observed across the team,
 * with catalog defaults and editable per-org monthly-price overrides. Plans are
 * grouped by normalized plan key (provider + plan type); individual account
 * emails are never shown. The pricing here feeds the billed-cost and savings
 * estimates on the Statistics → Overview tab.
 *
 * Visible to any member who can view usage stats; the fetched `canEdit` flag
 * (server-derived) controls whether the override inputs are editable.
 */
export function TeamSubscriptionPricingSection({
  detail,
}: TeamSubscriptionPricingSectionProps): JSX.Element | null {
  const client = useSettingsClient();
  const loadErrorCopy = useSettingsLoadFailure(PRICING_ERROR_SCOPE);
  const orgId = detail.id;
  const [plans, setPlans] = useState<SubscriptionPlanPricingRow[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  // A failed load offers Retry; a failed save does not.
  const [loadError, setLoadError] = useState<SettingsFailure | null>(null);
  const [error, setError] = useState<SettingsFailure | null>(null);

  const applyResponse = useCallback(
    (response: { plans: SubscriptionPlanPricingRow[]; canEdit: boolean }) => {
      setPlans(response.plans);
      setCanEdit(response.canEdit);
    },
    [],
  );

  const loadPricing = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    setError(null);
    try {
      applyResponse(await getSubscriptionPlanPricing(client, orgId));
    } catch (err: unknown) {
      setLoadError(loadErrorCopy(err, USAGE_KNOWN_LOAD_ERRORS));
    } finally {
      setLoading(false);
    }
  }, [client, orgId, applyResponse, loadErrorCopy]);

  // Initial load / reload on org switch. This is a genuine external sync
  // (network call) whose success path calls setState; that is the point of
  // the load.
  useEffect(() => {
    void loadPricing();
  }, [loadPricing]);

  if (!detail.canViewUsageStats) {
    return null;
  }

  return (
    <section
      className={SETTINGS_CARD_CLASS}
      data-testid="team-subscription-pricing-section"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <Heading level={2} variant="section">
          AI provider plan pricing
        </Heading>
        <p className={SETTINGS_CARD_SUBTITLE_CLASS}>
          Set the monthly price for each AI provider plan your team uses. These
          prices drive the billed-cost and savings estimates on the Statistics
          tab. We never show individual account emails.
        </p>
      </div>
      <div className={SETTINGS_CARD_GROUP_CLASS}>
        <ErrorBanner
          errorSource="team-subscription-pricing-section-load"
          className="mt-3"
          error={loadError?.copy}
          details={loadError?.details}
          onRetry={() => void loadPricing()}
        />
        <ErrorBanner
          errorSource="team-subscription-pricing-section"
          className="mt-3"
          error={error?.copy}
          details={error?.details}
        />

        {loading ? (
          <div className="mt-4">
            <DelayedLoadingPlaceholder>
              <Skeleton
                loading
                label="Loading plan pricing"
                testId="settings-skeleton-form"
                className="w-full"
              >
                <ul className="flex flex-col">
                  {SAMPLE_PLANS.map((plan) => (
                    <PlanRow
                      key={plan.planKey}
                      client={client}
                      orgId={orgId}
                      plan={plan}
                      canEdit={false}
                      onSaved={noop}
                      onError={noop}
                    />
                  ))}
                </ul>
              </Skeleton>
            </DelayedLoadingPlaceholder>
          </div>
        ) : loadError ? null : plans.length === 0 ? (
          <EmptyState
            testId="subscription-pricing-empty"
            title="No AI provider plans observed yet"
            subtitle="Plans appear here once your team drives agent work through an AI provider plan."
          />
        ) : (
          <ul className="flex flex-col">
            {plans.map((plan) => (
              <PlanRow
                key={plan.planKey}
                client={client}
                orgId={orgId}
                plan={plan}
                canEdit={canEdit}
                onSaved={applyResponse}
                onError={setError}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

const noop = (): void => undefined;

/** Sample plans for the loading state: plain, of the loaded shape. */
const SAMPLE_PLANS: readonly SubscriptionPlanPricingRow[] = [
  {
    planKey: 'sample-plan-1',
    provider: 'claude',
    label: 'Sample plan',
    rawPlanTypes: [],
    accountCount: 2,
    defaultMonthlyUsd: 100,
    overrideMonthlyUsd: null,
    effectiveMonthlyUsd: 100,
  },
  {
    planKey: 'sample-plan-2',
    provider: 'codex',
    label: 'Another plan',
    rawPlanTypes: [],
    accountCount: 1,
    defaultMonthlyUsd: 20,
    overrideMonthlyUsd: null,
    effectiveMonthlyUsd: 20,
  },
];

interface PlanRowProps {
  client: AccountOrganizationSettingsClient;
  orgId: string;
  plan: SubscriptionPlanPricingRow;
  canEdit: boolean;
  onSaved: (response: {
    plans: SubscriptionPlanPricingRow[];
    canEdit: boolean;
  }) => void;
  onError: (failure: SettingsFailure | null) => void;
}

function PlanRow({
  client,
  orgId,
  plan,
  canEdit,
  onSaved,
  onError,
}: PlanRowProps): JSX.Element {
  const [draft, setDraft] = useState<string>(
    plan.overrideMonthlyUsd === null ? '' : String(plan.overrideMonthlyUsd),
  );
  const [saving, setSaving] = useState(false);
  const errorCopy = useSettingsErrorCopy(PRICING_ERROR_SCOPE);

  const commit = async (monthlyPriceUsd: number | null): Promise<void> => {
    try {
      setSaving(true);
      onError(null);
      const response = await setSubscriptionPlanPriceOverride(
        client,
        orgId,
        plan.planKey,
        monthlyPriceUsd,
      );
      onSaved(response);
    } catch (err: unknown) {
      onError(errorCopy.actionFailure(err, { action: 'save the plan price' }));
    } finally {
      setSaving(false);
    }
  };

  const handleSave = (): void => {
    const trimmed = draft.trim();
    if (trimmed === '') {
      void commit(null);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0) {
      onError({ copy: 'Enter a valid non-negative monthly price.' });
      return;
    }
    void commit(parsed);
  };

  const handleClear = (): void => {
    setDraft('');
    void commit(null);
  };

  const effectiveLabel =
    plan.effectiveMonthlyUsd === null
      ? 'Unpriced'
      : formatUsd(plan.effectiveMonthlyUsd);
  const defaultLabel =
    plan.defaultMonthlyUsd === null
      ? 'No default'
      : `${formatUsd(plan.defaultMonthlyUsd)}/mo default`;

  return (
    <li
      className={`${SETTINGS_CARD_ROW_CLASS} flex-wrap`}
      data-testid={`subscription-plan-row-${plan.planKey}`}
    >
      <div className="min-w-0">
        <p className="text-s font-medium fg-primary">
          {plan.label}{' '}
          <span className="text-xs font-normal fg-secondary">
            {formatProviderLabel(plan.provider)}
          </span>
        </p>
        <p className="text-xs fg-secondary">
          {plan.accountCount} account{plan.accountCount === 1 ? '' : 's'} ·{' '}
          {defaultLabel} · effective {effectiveLabel}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <div className="w-28">
          <TextInput
            density="settings"
            leading="$"
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            value={draft}
            disabled={!canEdit || saving}
            aria-label={`Monthly price override for ${plan.label}`}
            data-testid={`subscription-plan-price-input-${plan.planKey}`}
            placeholder={
              plan.defaultMonthlyUsd === null
                ? '0.00'
                : plan.defaultMonthlyUsd.toFixed(2)
            }
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>
        {canEdit ? (
          <>
            <Button
              variant="secondary"
              size="compact"
              disabled={saving}
              data-testid={`subscription-plan-price-save-${plan.planKey}`}
              onClick={handleSave}
            >
              Save
            </Button>
            {plan.overrideMonthlyUsd !== null ? (
              <Button
                variant="secondary"
                size="compact"
                disabled={saving}
                data-testid={`subscription-plan-price-clear-${plan.planKey}`}
                onClick={handleClear}
              >
                Clear
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
    </li>
  );
}
