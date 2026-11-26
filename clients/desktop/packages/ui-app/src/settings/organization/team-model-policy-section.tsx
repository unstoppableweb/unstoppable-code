'use client';

import { Stack } from '@canopy/ui-shared/primitives/Stack';

import {
  SETTINGS_CARD_CLASS,
  SETTINGS_CARD_GROUP_CLASS,
  SETTINGS_CARD_SUBTITLE_CLASS,
  SETTINGS_CARD_ROW_CLASS,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import {
  Button,
  DelayedLoadingPlaceholder,
  ErrorBanner,
  Skeleton,
  SettingsRowsRow,
  ToggleSwitch,
  EmptyStateRow,
  Heading,
} from '@canopy/ui-shared/components';
import type {
  OrganizationConfigDetail,
  OrganizationDetail,
} from '@canopy/protocol/settings/organization';
import { canEditOrgEnforcedSettings } from '@canopy/protocol/settings/organization-permissions';
import { SettingsConfirmDialog, useSettingsClient } from '../host';
import { useSettingsErrorCopy, useSettingsLoadFailure } from '../errors';
import {
  fetchOrgModelCatalog,
  getOrganizationConfig,
  updateBlockedModelIds,
  updateEnforceMemberModelPolicy,
  type OrgModelCatalogEntry,
} from './team-api';
import type { SettingsFailure } from '../errors';
import { Badge } from '@canopy/ui-shared/primitives/Badge';

const MODEL_POLICY_ERROR_SCOPE = 'settings.organization.model-policy';

/** How many model rows one page of the list shows. */
const PAGE_SIZE = 15;

interface TeamModelPolicySectionProps {
  detail: OrganizationDetail;
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
 * Self-gated on `canEditOrgEnforcedSettings`, like the data-sharing card it
 * sits beside.
 */
export function TeamModelPolicySection({
  detail,
}: TeamModelPolicySectionProps): JSX.Element | null {
  if (!canEditOrgEnforcedSettings(detail.viewerRole)) {
    return null;
  }

  return <ModelPolicyCard detail={detail} />;
}

function ModelPolicyCard({ detail }: TeamModelPolicySectionProps): JSX.Element {
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

  /**
   * Retry runs every load again. Clearing the errors puts the card back on
   * its placeholder until the reads settle.
   */
  const retryLoad = (): void => {
    setLoadError(null);
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

  const showList = enforcing === true;

  const handleMasterChange = (next: boolean): void => {
    void saveMaster(next);
  };

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
      <div className={`${SETTINGS_CARD_GROUP_CLASS} flex flex-col gap-4`}>
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
        </Stack>
        <div>
          {enforcing === null || !catalogReady ? (
            <div data-testid="model-policy-pending">
              <DelayedLoadingPlaceholder>
                <ModelPolicySkeleton />
              </DelayedLoadingPlaceholder>
            </div>
          ) : (
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
            </Stack>
          )}

          {showList ? (
            <>
              {pendingReviewIds.length > 0 ? (
                <div className="pt-4 flex flex-wrap items-center justify-between gap-2">
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
                  className="pt-3 flex items-center justify-between gap-3"
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
                  // The banner above already records this request failure.
                  errorRecordingDisabled
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
                        You can still block any model afterwards, and new models
                        that ship later stay blocked until you review them too.
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
  onChange: (allow: boolean) => void;
}

function ModelPolicyRow({
  model,
  allowed,
  pendingReview,
  busy,
  onChange,
}: ModelPolicyRowProps): JSX.Element {
  const toggle = (
    <ToggleSwitch
      checked={allowed}
      label={`Allow ${model.label}${
        pendingReview ? ' (new; blocked until reviewed)' : ''
      }`}
      disabled={busy}
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
      {toggle}
    </li>
  );
}
