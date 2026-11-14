'use client';

import { Stack } from '@canopy/ui-shared/components/Stack';

import {
  SETTINGS_CARD_CLASS,
  SETTINGS_CARD_GROUP_CLASS,
  SETTINGS_CARD_SUBTITLE_CLASS,
  SETTINGS_CARD_ROW_CLASS,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Lock } from '@canopy/ui-shared/icons/AppIcons';
import {
  Button,
  DelayedLoadingPlaceholder,
  ErrorBanner,
  Notice,
  Skeleton,
  SettingsRowsRow,
  ToggleSwitch,
  Tooltip,
  EmptyStateRow,
  Heading,
} from '@canopy/ui-shared/components';
import { organizationBillingPath } from '@canopy/protocol/billing';
import type {
  OrganizationConfigDetail,
  OrganizationDetail,
} from '@canopy/protocol/settings/organization';
import { MODEL_POLICY_CAPABILITY } from '@canopy/protocol/settings/organization';
import { lowestPlanNameWithCapability } from '@canopy/protocol/settings/billing-plan-catalog';
import { canEditOrgEnforcedSettings } from '@canopy/protocol/settings/organization-permissions';
import {
  SettingsConfirmDialog,
  SettingsLink,
  useSettingsClient,
} from '../host';
import { useSettingsErrorCopy, useSettingsLoadFailure } from '../errors';
import { ORGANIZATION_LAPSED_ERROR } from './organization-known-errors';
import {
  fetchOrgModelCatalog,
  getOrganizationConfig,
  getOrgBillingSummary,
  updateBlockedModelIds,
  updateEnforceMemberModelPolicy,
  type OrgModelCatalogEntry,
} from './team-api';
import type { SettingsFailure } from '../errors';
import { Badge } from '@canopy/ui-shared/components/Badge';

const MODEL_POLICY_ERROR_SCOPE = 'settings.organization.model-policy';

/** How many model rows one page of the list shows. */
const PAGE_SIZE = 15;

interface TeamModelPolicySectionProps {
  detail: OrganizationDetail;
  /**
   * Server-resolved free app access (CAN-3926). Every capability is granted
   * then, so the card skips the plan read: a failed read must not paint an
   * "Upgrade" door over a feature the organization already has.
   */
  freeAccess?: boolean;
}

/**
 * Owner/admin home for the org's model policy: which models members may use on
 * any Canopy agent surface.
 *
 * This is a governance control, not a cost control — it is the groundwork for a
 * zero-data-retention posture where an org's agreement covers some vendors and
 * not others. Two consequences shape this card:
 *
 * 1. A toggle is a statement about the MODEL, not about how a turn is billed,
 *    so a blocked model is unreachable through AI Credits and through a native
 *    provider sign-in alike.
 * 2. A model the org has never seen is not a model it has cleared. The runtime
 *    blocks anything absent from `reviewedModelIds`, so this card has to make
 *    that visible — hence the "new" affordance and the pending count.
 *
 * Because of (2), review is only ever recorded for models the admin actually
 * acted on. A per-row toggle adds THAT row to the reviewed snapshot and nothing
 * else: the list is paginated, so writing the whole catalog back on any save
 * would clear the "new" state for pages the admin never opened and turn
 * "reviewed" into "the admin saved something". Clearing a whole backlog at once
 * is possible, but only through the explicit, confirmed "Mark all as reviewed"
 * action.
 *
 * Entitlement changes what the card offers, not whether the policy is real:
 * an org whose plan lapsed while enforcement is ON still gets working controls,
 * limited to the relaxing direction the server accepts (see `relaxOnly` below).
 * The upsell-only door is for orgs with no live policy at all.
 *
 * Self-gated on `canEditOrgEnforcedSettings`, like the data-sharing card it
 * sits beside.
 */
export function TeamModelPolicySection({
  detail,
  freeAccess = false,
}: TeamModelPolicySectionProps): JSX.Element | null {
  if (!canEditOrgEnforcedSettings(detail.viewerRole)) {
    return null;
  }

  return <ModelPolicyCard detail={detail} freeAccess={freeAccess} />;
}

function ModelPolicyCard({
  detail,
  freeAccess = false,
}: TeamModelPolicySectionProps): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(MODEL_POLICY_ERROR_SCOPE);
  const loadErrorCopy = useSettingsLoadFailure(MODEL_POLICY_ERROR_SCOPE);
  const orgId = detail.id;

  const [enforcing, setEnforcing] = useState<boolean | null>(null);
  const [blocked, setBlocked] = useState<ReadonlySet<string>>(new Set());
  const [reviewed, setReviewed] = useState<ReadonlySet<string>>(new Set());
  const [catalog, setCatalog] = useState<readonly OrgModelCatalogEntry[]>([]);
  const [catalogReady, setCatalogReady] = useState(false);
  const [loadError, setLoadError] = useState<SettingsFailure | null>(null);
  const [error, setError] = useState<SettingsFailure | null>(null);
  const [savingMaster, setSavingMaster] = useState(false);
  const [savingModelId, setSavingModelId] = useState<string | null>(null);
  const [savingReviewAll, setSavingReviewAll] = useState(false);
  const [confirmReviewAll, setConfirmReviewAll] = useState(false);
  const [page, setPage] = useState(0);
  // Bumped by Retry to run every load again.
  const [loadAttempt, setLoadAttempt] = useState(0);

  /**
   * `null` until the billing read resolves, and permanently `null` if it
   * fails — the same three-state contract the data-sharing card uses. An
   * unknown entitlement rendered as "entitled" would paint an interactive
   * policy card for an org that does not have the capability, and every toggle
   * on it would 403.
   */
  const [planEntitled, setEntitled] = useState<boolean | null>(null);
  const entitled = freeAccess ? true : planEntitled;
  /**
   * Held apart from `error` on purpose: a save clears `error`, and an
   * unresolved plan-read failure must not be erased by the first toggle.
   */
  const [entitlementError, setEntitlementError] =
    useState<SettingsFailure | null>(null);

  /**
   * The configuration the SERVER last confirmed, which is what the next PATCH
   * body is built from. A per-model save sends the whole array, so rebasing on
   * render-time state would let a second toggle started mid-flight send the
   * first one's pre-toggle value back and silently revert it.
   */
  const latestBlockedRef = useRef<ReadonlySet<string>>(new Set());
  /**
   * The reviewed snapshot the SERVER last confirmed, for the same reason as
   * `latestBlockedRef`: `reviewedModelIds` is a full replacement, so every save
   * has to extend the stored snapshot rather than the render-time one.
   */
  const latestReviewedRef = useRef<ReadonlySet<string>>(new Set());

  const saving = savingMaster || savingModelId !== null || savingReviewAll;
  const entitlementResolved = entitled !== null || entitlementError !== null;
  const requiredPlanName = lowestPlanNameWithCapability(
    MODEL_POLICY_CAPABILITY,
  );

  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const config = await getOrganizationConfig(client, orgId);
        if (cancelled) {
          return;
        }
        setEnforcing(config.enforceMemberModelPolicy);
        const nextBlocked = new Set(config.blockedModelIds);
        latestBlockedRef.current = nextBlocked;
        setBlocked(nextBlocked);
        const nextReviewed = new Set(config.reviewedModelIds);
        latestReviewedRef.current = nextReviewed;
        setReviewed(nextReviewed);
      } catch (err) {
        if (!cancelled) setLoadError(loadErrorCopy(err));
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [client, orgId, loadErrorCopy, loadAttempt]);

  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const models = await fetchOrgModelCatalog(client);
        if (!cancelled) {
          setCatalog(models);
          setCatalogReady(true);
        }
      } catch (err) {
        if (!cancelled) setLoadError(errorCopy.loadFailure(err));
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [client, errorCopy, loadAttempt]);

  useEffect(() => {
    if (freeAccess) {
      return;
    }
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const summary = await getOrgBillingSummary(client, orgId);
        if (!cancelled) {
          setEntitled(summary.capabilities.includes(MODEL_POLICY_CAPABILITY));
        }
      } catch (err) {
        // Leaves `entitled` null — unknown, not "entitled". The PATCH route
        // capability-gates server-side either way, so this only decides what
        // the card is allowed to CLAIM, never what the org actually gets.
        if (!cancelled) setEntitlementError(errorCopy.loadFailure(err));
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [client, orgId, freeAccess, errorCopy, loadAttempt]);

  /**
   * Retry runs every load again. Clearing the errors puts the card back on
   * its placeholder until the reads settle.
   */
  const retryLoad = (): void => {
    setLoadError(null);
    setEntitlementError(null);
    setLoadAttempt((attempt) => attempt + 1);
  };

  /**
   * Models in the catalog the org has never saved a review for. They are
   * blocked RIGHT NOW at runtime, which is why they are surfaced rather than
   * quietly folded into the allowed rows: otherwise a model vanishes for every
   * member on a Canopy release the org did not ask for, and the admin has no
   * way to connect the two.
   */
  const pendingReviewIds = useMemo(
    () =>
      enforcing === true
        ? catalog.filter((m) => !reviewed.has(m.id)).map((m) => m.id)
        : [],
    [catalog, reviewed, enforcing],
  );
  const pendingReviewSet = useMemo(
    () => new Set(pendingReviewIds),
    [pendingReviewIds],
  );

  const pageCount = Math.max(1, Math.ceil(catalog.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = catalog.slice(
    currentPage * PAGE_SIZE,
    currentPage * PAGE_SIZE + PAGE_SIZE,
  );

  const reportError = (err: unknown): void => {
    setError(
      errorCopy.actionFailure(err, {
        action: 'update the model policy',
        known: [ORGANIZATION_LAPSED_ERROR],
      }),
    );
  };

  /** Rebase every local view of the policy on what the server just confirmed. */
  const adoptConfig = (config: OrganizationConfigDetail): void => {
    setEnforcing(config.enforceMemberModelPolicy);
    const nextBlocked = new Set(config.blockedModelIds);
    latestBlockedRef.current = nextBlocked;
    setBlocked(nextBlocked);
    const nextReviewed = new Set(config.reviewedModelIds);
    latestReviewedRef.current = nextReviewed;
    setReviewed(nextReviewed);
  };

  const saveMaster = async (next: boolean): Promise<void> => {
    /*
     * Turning enforcement ON for the FIRST time baselines the whole catalog:
     * nothing was blocked a moment ago, so blocking everything until each model
     * is reviewed would strand every member instead of describing a policy.
     * Once a snapshot exists it is preserved verbatim — otherwise an off/on
     * cycle would launder unreviewed models into it, which is the same silent
     * unblock the per-row save is careful to avoid. Turning enforcement OFF
     * records no review at all; it is not a statement about any model.
     */
    const reviewedIds =
      next && latestReviewedRef.current.size === 0
        ? catalog.map((model) => model.id)
        : [...latestReviewedRef.current];
    try {
      setSavingMaster(true);
      setError(null);
      adoptConfig(
        await updateEnforceMemberModelPolicy(client, orgId, next, reviewedIds),
      );
    } catch (err) {
      reportError(err);
    } finally {
      setSavingMaster(false);
    }
  };

  const saveModel = async (modelId: string, allow: boolean): Promise<void> => {
    const nextBlocked = new Set(latestBlockedRef.current);
    if (allow) {
      nextBlocked.delete(modelId);
    } else {
      nextBlocked.add(modelId);
    }
    // Review is recorded for THIS model only. The list is paginated, so sending
    // the whole catalog here would clear the "new" state for models sitting on
    // pages the admin never opened — see the card's doc comment.
    const nextReviewed = new Set(latestReviewedRef.current);
    nextReviewed.add(modelId);
    try {
      setSavingModelId(modelId);
      setError(null);
      adoptConfig(
        await updateBlockedModelIds(
          client,
          orgId,
          [...nextBlocked],
          [...nextReviewed],
        ),
      );
    } catch (err) {
      reportError(err);
    } finally {
      setSavingModelId(null);
    }
  };

  /**
   * The one path that clears a whole backlog at once, behind an explicit button
   * and a confirmation that names the count. Deliberately not a side effect of
   * anything else: this is the org saying "we accept every model currently in
   * the catalog", which is exactly the statement the runtime reads back.
   */
  const markAllReviewed = async (): Promise<void> => {
    const nextReviewed = new Set(latestReviewedRef.current);
    for (const model of catalog) {
      nextReviewed.add(model.id);
    }
    try {
      setSavingReviewAll(true);
      setError(null);
      adoptConfig(
        await updateBlockedModelIds(
          client,
          orgId,
          [...latestBlockedRef.current],
          [...nextReviewed],
        ),
      );
      setConfirmReviewAll(false);
    } catch (err) {
      reportError(err);
    } finally {
      setSavingReviewAll(false);
    }
  };

  /**
   * Enforcement is ON but the capability is gone: a plan lapsed under a policy
   * that is still refusing models for every member right now.
   *
   * The runtime keeps enforcing here on purpose (a compliance boundary is not a
   * cost control), so a painted door in this state would be a trap: the org
   * would have a live policy, an allowlist that blocks every model shipped
   * after its last save, and no control anywhere to undo either one. So the
   * REAL controls render, in the one direction the server still accepts, which
   * `modelPolicyTightens` in `lib/teams/team-service.ts` defines: turn the
   * master switch off, unblock a model, review more models. Anything that would
   * point the policy at MORE than it already covers is locked rather than left
   * to fail on save.
   *
   * Strictly `=== false`. An unresolved plan read leaves `entitled` null, and
   * unknown is not "downgraded".
   */
  const relaxOnly = enforcing === true && entitled === false;
  const showList = enforcing === true && (entitled === true || relaxOnly);

  /**
   * Turning enforcement back ON is a tightening, so a relax-only card never
   * sends it. The switch is checked whenever `relaxOnly` holds, so this only
   * guards against the state changing under an in-flight click.
   */
  const handleMasterChange = (next: boolean): void => {
    if (relaxOnly && next) {
      return;
    }
    void saveMaster(next);
  };

  const upgradeText = requiredPlanName
    ? `Upgrade to ${requiredPlanName}`
    : 'Upgrade';
  const billingHref = organizationBillingPath(orgId);

  return (
    <section
      className={SETTINGS_CARD_CLASS}
      data-testid="team-model-policy-section"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Heading level={2} variant="section">
              Model access
            </Heading>
            <p className={SETTINGS_CARD_SUBTITLE_CLASS}>
              Choose which AI models your members may use.
            </p>
          </div>
          {showList && pendingReviewIds.length > 0 ? (
            <Badge
              tone="warning"
              className="shrink-0"
              data-testid="model-policy-pending-review-count"
            >
              {pendingReviewIds.length} new
            </Badge>
          ) : null}
        </div>
      </div>
      <div
        className={`${SETTINGS_CARD_GROUP_CLASS} flex flex-col ${entitlementResolved && enforcing !== null && catalogReady && entitled !== true && !relaxOnly ? 'gap-0' : 'gap-4'}`}
      >
        <Stack gap="item" className="empty:hidden">
          <ErrorBanner
            errorSource="team-model-policy-request"
            className=""
            error={error?.copy}
            details={error?.details}
          />
          <ErrorBanner
            errorSource="model-policy-card-load"
            className=""
            error={loadError?.copy}
            details={loadError?.details}
            onRetry={retryLoad}
          />
          {/* Its own banner: a save clears `error` and must not take an
              unresolved plan-read failure with it. */}
          <ErrorBanner
            errorSource="team-model-policy-entitlement"
            className=""
            // One load banner: both share the same copy and Retry.
            error={loadError === null ? entitlementError?.copy : null}
            details={loadError === null ? entitlementError?.details : undefined}
            onRetry={retryLoad}
          />
        </Stack>
        <div>
          {!entitlementResolved || enforcing === null || !catalogReady ? (
            <div data-testid="model-policy-pending">
              <DelayedLoadingPlaceholder>
                <ModelPolicySkeleton />
              </DelayedLoadingPlaceholder>
            </div>
          ) : entitled === true || relaxOnly ? (
            <Stack gap="item">
              <div>
                <SettingsRowsRow
                  label="Enforce member model access policy"
                  description="Members can only use the models you choose from an enabled policy."
                  control={
                    <ToggleSwitch
                      label="Enforce member model access policy"
                      checked={enforcing}
                      disabled={saving}
                      dataTestId="enforce-member-model-policy-checkbox"
                      onChange={handleMasterChange}
                    />
                  }
                />
              </div>
              {relaxOnly ? (
                <Notice
                  intent="attention"
                  icon={<Lock size={14} />}
                  data-testid="model-policy-relax-only-note"
                >
                  Your plan no longer includes a model policy, but the one you
                  set is still in force for your members, and models released
                  since your last save are blocked too. From here you can turn
                  enforcement off or allow models it blocks. To block a model
                  again, or to turn enforcement back on later, you&apos;ll need
                  the capability back.{' '}
                  <SettingsLink
                    href={billingHref}
                    data-testid="model-policy-relax-only-upgrade"
                    className="underline fg-accent"
                  >
                    {upgradeText}
                  </SettingsLink>
                </Notice>
              ) : null}
            </Stack>
          ) : (
            /*
             * Painted door, for an org with no capability AND no live policy
             * (enforcement off, or a plan read that never resolved). The switch
             * stays VISIBLE so the capability is discoverable, but the model
             * list never renders: showing an uneditable list of models would
             * read as a policy this org has, and it has none. An org that IS
             * still enforcing gets the relax-only controls above instead, since
             * for it the policy is real and it needs a way out.
             */
            <Tooltip
              label={
                <span className="block max-w-64 whitespace-normal">
                  Your plan doesn&apos;t include a model policy, so members may
                  use any model.
                </span>
              }
              link={{
                href: billingHref,
                text: upgradeText,
                external: false,
              }}
            >
              <span
                className="mt-4 flex cursor-not-allowed items-start gap-3 opacity-60"
                data-testid="model-policy-upgrade-cta"
              >
                <Lock
                  size={14}
                  aria-hidden="true"
                  className="mt-0.5 fg-secondary/70"
                />
                <span className="min-w-0">
                  <span className="block text-s font-medium fg-primary">
                    Enforce member model access policy
                  </span>
                  <span className="block text-xs fg-secondary">
                    {requiredPlanName
                      ? `Available on ${requiredPlanName}.`
                      : 'Not included in your plan.'}
                  </span>
                </span>
              </span>
            </Tooltip>
          )}

          {showList ? (
            <>
              {pendingReviewIds.length > 0 ? (
                <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                  <p
                    className="text-xs fg-warning"
                    data-testid="model-policy-pending-review-note"
                  >
                    {pendingReviewIds.length === 1
                      ? '1 model is new since your last save and is blocked until you review it. Switch it on to allow it.'
                      : `${pendingReviewIds.length} models are new since your last save and are blocked until you review them. Switch each one on to allow it.`}
                  </p>
                  <Button
                    variant="secondary"
                    size="compact"
                    disabled={saving}
                    data-testid="model-policy-mark-all-reviewed"
                    onClick={() => {
                      setError(null);
                      setConfirmReviewAll(true);
                    }}
                  >
                    Mark all as reviewed
                  </Button>
                </div>
              ) : null}

              <ul className="flex flex-col" data-testid="model-policy-list">
                {visible.map((model) => (
                  <ModelPolicyRow
                    key={model.id}
                    model={model}
                    allowed={
                      !blocked.has(model.id) && !pendingReviewSet.has(model.id)
                    }
                    pendingReview={pendingReviewSet.has(model.id)}
                    busy={saving}
                    /*
                     * Only an ALLOWED row locks in relax-only mode: switching
                     * it off would add a blocked id, which the server refuses
                     * without the capability. Blocked and unreviewed rows stay
                     * live, because switching those on is a relaxation.
                     */
                    locked={
                      relaxOnly &&
                      !blocked.has(model.id) &&
                      !pendingReviewSet.has(model.id)
                    }
                    upgradeHref={billingHref}
                    upgradeText={upgradeText}
                    onChange={(allow) => void saveModel(model.id, allow)}
                  />
                ))}
                {visible.length === 0 ? (
                  <li className="px-4">
                    <EmptyStateRow
                      testId="model-policy-empty"
                      title="No models are available to configure yet."
                    />
                  </li>
                ) : null}
              </ul>

              {pageCount > 1 ? (
                <div
                  className="mt-3 flex items-center justify-between gap-3"
                  data-testid="model-policy-pager"
                >
                  <Button
                    variant="secondary"
                    size="compact"
                    disabled={currentPage === 0}
                    data-testid="model-policy-pager-prev"
                    onClick={() => setPage(Math.max(0, currentPage - 1))}
                  >
                    Previous
                  </Button>
                  <span className="text-xs fg-secondary">
                    Page {currentPage + 1} of {pageCount}
                  </span>
                  <Button
                    variant="secondary"
                    size="compact"
                    disabled={currentPage >= pageCount - 1}
                    data-testid="model-policy-pager-next"
                    onClick={() =>
                      setPage(Math.min(pageCount - 1, currentPage + 1))
                    }
                  >
                    Next
                  </Button>
                </div>
              ) : null}

              {confirmReviewAll && pendingReviewIds.length > 0 ? (
                <SettingsConfirmDialog
                  dataTestId="model-policy-review-all-dialog"
                  errorMessage={error?.copy}
                  errorDetails={error?.details}
                  title={
                    pendingReviewIds.length === 1
                      ? 'Mark 1 model as reviewed?'
                      : `Mark ${pendingReviewIds.length} models as reviewed?`
                  }
                  confirmLabel="Mark as reviewed"
                  busyLabel="Saving…"
                  busy={savingReviewAll}
                  onCancel={() => setConfirmReviewAll(false)}
                  onConfirm={() => void markAllReviewed()}
                  message={
                    <div className="flex flex-col gap-2">
                      <p>
                        This clears the review backlog for every model in the
                        catalog, including any on pages you have not opened yet.
                        Each one becomes available to your members right away
                        unless you block it.
                      </p>
                      <p>
                        {relaxOnly
                          ? 'New models that ship later stay blocked until you review them too. Your plan no longer lets you block a model, though, so only do this if every model in the catalog is fine for your members.'
                          : 'You can still block any model afterwards, and new models that ship later stay blocked until you review them too.'}
                      </p>
                    </div>
                  }
                />
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}

const noop = (): void => undefined;

/** Sample models for the loading state: plain, of the loaded shape. */
const SAMPLE_POLICY_MODELS: readonly OrgModelCatalogEntry[] = [
  { id: 'sample-model-1', label: 'Sample model' },
  { id: 'sample-model-2', label: 'Another model' },
];

/**
 * The card body while the policy loads: its enforcement switch and model rows
 * with sample models inside `Skeleton`, so skullet measures them into bars in
 * place.
 */
function ModelPolicySkeleton(): JSX.Element {
  return (
    <Skeleton
      loading
      label="Loading model policy"
      testId="settings-skeleton-form"
      className="w-full"
    >
      <SettingsRowsRow
        label="Enforce member model access policy"
        description="Members can only use the models you choose."
        control={
          <ToggleSwitch
            label="Enforce member model access policy"
            checked={false}
            onChange={noop}
          />
        }
      />
      <ul className="flex flex-col">
        {SAMPLE_POLICY_MODELS.map((model) => (
          <ModelPolicyRow
            key={model.id}
            model={model}
            allowed
            pendingReview={false}
            busy={false}
            locked={false}
            upgradeHref=""
            upgradeText=""
            onChange={noop}
          />
        ))}
      </ul>
    </Skeleton>
  );
}

interface ModelPolicyRowProps {
  model: OrgModelCatalogEntry;
  /** Whether members may currently use this model. */
  allowed: boolean;
  /** Whether this model is new since the org's last save (blocked until reviewed). */
  pendingReview: boolean;
  /** True while ANY save on the card is in flight, not just this row's. */
  busy: boolean;
  /**
   * Whether flipping this row would tighten a policy the org no longer holds
   * the capability for. Locked rows are inert rather than merely doomed to
   * fail on save.
   */
  locked: boolean;
  /** Where a locked row sends an admin to get the capability back. */
  upgradeHref: string;
  upgradeText: string;
  onChange: (allow: boolean) => void;
}

function ModelPolicyRow({
  model,
  allowed,
  pendingReview,
  busy,
  locked,
  upgradeHref,
  upgradeText,
  onChange,
}: ModelPolicyRowProps): JSX.Element {
  const toggle = (
    <ToggleSwitch
      checked={allowed}
      unavailable={locked}
      label={`Allow ${model.label}${
        pendingReview ? ' (new; blocked until reviewed)' : ''
      }${locked ? ' (locked by your plan)' : ''}`}
      disabled={locked ? undefined : busy}
      dataTestId={`model-policy-toggle-${model.id}`}
      onChange={onChange}
    />
  );

  return (
    <li
      className={SETTINGS_CARD_ROW_CLASS}
      data-testid={`model-policy-row-${model.id}`}
    >
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-s font-medium fg-primary">
          <span className="truncate">{model.label}</span>
          {pendingReview ? (
            <Badge
              tone="warning"
              className="shrink-0"
              data-testid={`model-policy-new-badge-${model.id}`}
            >
              New
            </Badge>
          ) : null}
        </p>
        {model.description ? (
          <p className="text-xs fg-secondary">{model.description}</p>
        ) : null}
        <p className="truncate text-xs fg-secondary/80">{model.id}</p>
      </div>
      {locked ? (
        <Tooltip
          label={
            <span className="block max-w-64 whitespace-normal">
              Your plan no longer lets you block models. You can still allow
              ones this policy blocks today.
            </span>
          }
          link={{ href: upgradeHref, text: upgradeText, external: false }}
        >
          {/*
           * The lock glyph shares the tooltip's hover target with the switch,
           * and `aria-disabled` keeps that target focusable: a natively
           * disabled button leaves the tab order and fires no hover events, so
           * the explanation would be unreachable. The always-visible note above
           * the list carries the same reason for keyboard users, since the
           * tooltip's link is portalled and cannot be tabbed to.
           */}
          <span className="flex shrink-0 items-center gap-2">
            <Lock size={12} aria-hidden="true" className="fg-secondary/70" />
            {toggle}
          </span>
        </Tooltip>
      ) : (
        toggle
      )}
    </li>
  );
}
