'use client';

import { SettingsChartLoading } from '../../pages/loading-skeletons';
import { useGlidingNumber } from './use-gliding-number';

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import {
  Button,
  ChoiceList,
  ChoiceListRow,
  DelayedLoadingPlaceholder,
  DialogModal,
  Disclosure,
  ErrorBanner,
  ErrorState,
  ProgressBar,
  Notice,
  ThinkingSpinner,
  CopyDetailsButton,
  Heading,
  DataTable,
} from '@canopy/ui-shared/components';
import type {
  ModelRoutingBacktestEstimateV1,
  ModelRoutingBacktestLookupResponseV1,
  ModelRoutingBacktestMode,
  ModelRoutingBacktestResultV1,
  ModelRoutingBacktestV1,
} from '@canopy/protocol/model-routing';
import type { TelemetryHeadlineCard } from '@canopy/protocol/telemetry';
import { SettingsLink, useSettingsBrand, useSettingsClient } from '../../host';
import { useSettingsErrorCopy, type SettingsFailure } from '../../errors';
import { TeamApiError } from '../team-api';
import { HeadlineCards } from './HeadlineCards';
import { formatCount, formatUsd } from './format';
import {
  createRoutingBacktest,
  getRoutingBacktest,
  lookupRoutingBacktest,
  type RoutingBacktestRange,
  type RoutingBacktestSubject,
} from './routing-backtest-api';
import {
  BACKTEST_ACTUAL_COLOR,
  BACKTEST_AUTO_COLOR,
  createErrorMessage,
  displayedSavings,
  failureMessage,
  formatShare,
  modelLabel,
  modelShareRows,
  progressStageMessage,
  routingBacktestCopy,
  routingBacktestProgressStage,
  unavailableMessage,
  type RoutingBacktestCopy,
} from './routing-backtest-display';
import { Surface } from '@canopy/ui-shared/components';

// The charts pull in recharts; load them only once a result renders, so the
// pages that mount this card (Public profile, Statistics) stay chart-free
// until there is something to plot.
const ComparisonLineChart = lazy(() =>
  import('../../../charts/charts').then((module) => ({
    default: module.ComparisonLineChart,
  })),
);
const PairedCategoryBarChart = lazy(() =>
  import('../../../charts/charts').then((module) => ({
    default: module.PairedCategoryBarChart,
  })),
);

const POLL_INTERVAL_MS = 3_000;
/** Logger scope for the routing estimate card. */
const ROUTING_BACKTEST_ERROR_SCOPE = 'settings.routing-backtest';
/** Consecutive failed polls before the card stops and offers a retry. */
export const MAX_POLL_FAILURES = 5;

interface RoutingBacktestCardProps {
  subject: RoutingBacktestSubject;
  /** Width of the selected range; the card reads it relative to now. */
  rangeMs: number;
  rangeLabel: string;
  /** Opens billing when the payer needs more AI Credits. */
  billingHref: string;
  /**
   * Caller controls (for example a range picker) shown in the card header,
   * so they hide with the card when the feature is off.
   */
  controls?: ReactNode;
  /**
   * `card` stands alone; `inset` is a tonal subpanel inside a parent card
   * (the Statistics "Model routing" panel), so it drops the elevation
   * and takes a heading that reads as part of that panel.
   */
  variant?: 'card' | 'inset';
}

function isActive(backtest: ModelRoutingBacktestV1 | null): boolean {
  return backtest?.status === 'queued' || backtest?.status === 'running';
}

/**
 * "What would model routing have saved?" for the selected range.
 * Looks up a cached run for the range and filter, offers to start one (paid
 * from AI Credits, confirmed first because prompts leave for the routing
 * service), polls while it runs, and renders the estimate.
 */
export function RoutingBacktestCard({
  subject,
  rangeMs,
  rangeLabel,
  billingHref,
  controls,
  variant = 'card',
}: RoutingBacktestCardProps): JSX.Element | null {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(ROUTING_BACKTEST_ERROR_SCOPE);
  const [range, setRange] = useState<RoutingBacktestRange | null>(null);
  const [lookup, setLookup] =
    useState<ModelRoutingBacktestLookupResponseV1 | null>(null);
  const [backtest, setBacktest] = useState<ModelRoutingBacktestV1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<SettingsFailure | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [pollFailures, setPollFailures] = useState(0);
  // A run that finishes while the card is open slides its results in; a
  // cached result on load just appears.
  const [finishedLive, setFinishedLive] = useState(false);
  // Bumped by every lookup so a poll sent for the previous range or filter
  // can't land on top of the new lookup's result.
  const lookupGeneration = useRef(0);

  // `subject` is an object literal at each call site; rebuild it from its
  // primitive fields so the effects re-run only when the filter changes.
  const orgId = subject.kind === 'organization' ? subject.orgId : undefined;
  const scope = subject.kind === 'organization' ? subject.scope : undefined;
  const teamId = subject.kind === 'organization' ? subject.teamId : undefined;
  const userId = subject.kind === 'organization' ? subject.userId : undefined;
  const stableSubject = useMemo<RoutingBacktestSubject>(
    () =>
      orgId === undefined
        ? { kind: 'user' }
        : {
            kind: 'organization',
            orgId,
            scope: scope ?? 'organization',
            ...(teamId ? { teamId } : {}),
            ...(userId ? { userId } : {}),
          },
    [orgId, scope, teamId, userId],
  );

  useEffect(() => {
    let ignore = false;
    lookupGeneration.current += 1;
    const now = Date.now();
    const nextRange: RoutingBacktestRange = {
      startIso: new Date(now - rangeMs).toISOString(),
      endIso: new Date(now).toISOString(),
    };
    void (async (): Promise<void> => {
      setLoading(true);
      setLoadError(null);
      setFinishedLive(false);
      try {
        const result = await lookupRoutingBacktest(
          client,
          stableSubject,
          nextRange,
        );
        if (ignore) return;
        setRange(nextRange);
        setLookup(result);
        setBacktest(result.backtest);
      } catch (error: unknown) {
        if (ignore) return;
        setLookup(null);
        setBacktest(null);
        setLoadError(errorCopy.loadFailure(error));
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return (): void => {
      ignore = true;
    };
  }, [client, errorCopy, stableSubject, rangeMs, reloadToken]);

  const activeId = isActive(backtest) ? backtest?.id : undefined;
  const pollStopped = pollFailures >= MAX_POLL_FAILURES;
  useEffect(() => {
    if (!activeId || pollStopped) return;
    let ignore = false;
    const generation = lookupGeneration.current;
    const stale = (): boolean =>
      ignore || generation !== lookupGeneration.current;
    const timer = setTimeout(() => {
      void (async (): Promise<void> => {
        try {
          const next = await getRoutingBacktest(
            client,
            stableSubject,
            activeId,
          );
          if (stale()) return;
          setPollFailures(0);
          setBacktest(next);
          if (next.status === 'succeeded') setFinishedLive(true);
        } catch {
          // Retry on the next tick; after a run of failures (access revoked,
          // run gone, outage) stop and offer a retry instead of spinning.
          if (!stale()) setPollFailures((count) => count + 1);
        }
      })();
    }, POLL_INTERVAL_MS);
    return (): void => {
      ignore = true;
      clearTimeout(timer);
    };
  }, [activeId, backtest, client, stableSubject, pollFailures, pollStopped]);

  const handleStarted = useCallback((next: ModelRoutingBacktestV1): void => {
    setBacktest(next);
    setFinishedLive(false);
    setDialogOpen(false);
  }, []);

  if (lookup?.unavailableReason === 'feature_disabled') return null;

  const copy = routingBacktestCopy(subject.kind);
  const errorMessage =
    loadError?.copy ??
    (pollStopped && isActive(backtest)
      ? 'Unable to check on the estimate.'
      : null);

  return (
    <Surface
      variant={variant === 'inset' ? 'group' : 'raised'}
      padding="default"
      gap="group"
      data-testid="routing-backtest-card"
      data-variant={variant}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          {variant === 'inset' ? (
            <Heading level={4} variant="title">
              Estimate savings
            </Heading>
          ) : (
            <Heading level={3} variant="title">
              See what model routing would have saved
            </Heading>
          )}
          <p className="text-xs fg-secondary">{rangeLabel}</p>
        </div>
        {controls}
      </div>
      {loading && lookup === null ? (
        <div data-testid="routing-backtest-loading">
          <DelayedLoadingPlaceholder>
            <SettingsChartLoading />
          </DelayedLoadingPlaceholder>
        </div>
      ) : errorMessage ? (
        <ErrorState
          space="panel"
          testId="routing-backtest-error"
          retryTestId="routing-backtest-retry"
          message={errorMessage}
          details={loadError?.details}
          onRetry={() => {
            setPollFailures(0);
            setReloadToken((token) => token + 1);
          }}
        />
      ) : backtest && isActive(backtest) ? (
        <RoutingBacktestProgress backtest={backtest} />
      ) : backtest?.status === 'succeeded' && backtest.result ? (
        // A cached result stays visible even when this viewer can't start a
        // new run (for example a member who can view Statistics).
        <RoutingBacktestResults
          result={backtest.result}
          copy={copy}
          rangeLabel={rangeLabel}
          reveal={finishedLive}
        />
      ) : lookup?.unavailableReason ? (
        <p
          className="text-s fg-secondary"
          data-testid="routing-backtest-unavailable"
        >
          {unavailableMessage(lookup.unavailableReason)}
        </p>
      ) : (
        <RoutingBacktestStart
          copy={copy}
          estimate={lookup?.estimate ?? null}
          failed={backtest?.status === 'failed' ? backtest : null}
          billingHref={billingHref}
          onStart={() => setDialogOpen(true)}
        />
      )}
      {dialogOpen && range && lookup?.estimate ? (
        <RoutingBacktestConfirmDialog
          subject={stableSubject}
          range={range}
          estimate={lookup.estimate}
          billingHref={billingHref}
          onCancel={() => setDialogOpen(false)}
          onStarted={handleStarted}
        />
      ) : null}
    </Surface>
  );
}

function RoutingBacktestStart({
  copy,
  estimate,
  failed,
  billingHref,
  onStart,
}: {
  copy: RoutingBacktestCopy;
  estimate: ModelRoutingBacktestEstimateV1 | null;
  failed: ModelRoutingBacktestV1 | null;
  billingHref: string;
  onStart: () => void;
}): JSX.Element {
  const needsCredits =
    (estimate !== null && !estimate.balanceSufficient) ||
    failed?.failureCode === 'insufficient_credits';
  const outOfRuns = estimate !== null && estimate.runsRemainingToday <= 0;
  return (
    <div className="flex flex-col gap-3" data-testid="routing-backtest-start">
      <p className="text-s fg-secondary">{copy.replayIntro}</p>
      {failed?.failureCode ? (
        <ErrorBanner
          errorSource="routing-backtest-failed"
          className=""
          testId="routing-backtest-failed"
          error={failureMessage(failed.failureCode)}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        {needsCredits ? (
          <SettingsLink
            href={billingHref}
            className="text-s font-medium fg-accent hover:underline"
            data-testid="routing-backtest-add-credits"
          >
            Add AI Credits
          </SettingsLink>
        ) : (
          <Button
            size="compact"
            onClick={onStart}
            disabled={estimate === null || outOfRuns}
            data-testid="routing-backtest-run"
          >
            {failed ? 'Try again' : 'Estimate savings'}
          </Button>
        )}
        {outOfRuns ? (
          <span className="text-xs fg-secondary">
            No estimates left today. Try again tomorrow.
          </span>
        ) : null}
      </div>
    </div>
  );
}

function RoutingBacktestProgress({
  backtest,
}: {
  backtest: ModelRoutingBacktestV1;
}): JSX.Element {
  const { replayedTurnCount, plannedTurnCount } = backtest.progress;
  const stage = routingBacktestProgressStage(
    backtest.status,
    backtest.progress,
  );
  // Nothing is replayed while the run prepares, so the bar holds at zero and
  // the spinner carries the wait.
  const target =
    stage === 'preparing' ? 0 : Math.min(replayedTurnCount, plannedTurnCount);
  const shown = useGlidingNumber(target);
  // The bar takes the real value; its transform-based FLIP smooths the jump.
  const percentage =
    stage === 'preparing' ? 0 : Math.floor((target / plannedTurnCount) * 100);
  return (
    <div
      className="flex flex-col gap-2"
      data-testid="routing-backtest-progress"
      data-stage={stage}
    >
      <div className="flex items-center justify-between gap-3 text-xs">
        <p className="flex min-w-0 items-center gap-2 fg-primary">
          <ThinkingSpinner tone="accent" className="shrink-0" />
          <span className="min-w-0" aria-live="polite">
            {/* Keyed so each new stage slides in. */}
            <span
              key={stage}
              className="block animate-slide-up truncate"
              data-testid="routing-backtest-progress-status"
            >
              {progressStageMessage(stage)}
            </span>
          </span>
        </p>
        {stage === 'preparing' ? null : (
          <span
            className="shrink-0 tabular-nums fg-secondary"
            data-testid="routing-backtest-progress-count"
          >
            {formatCount(shown)} of {formatCount(plannedTurnCount)} turns
          </span>
        )}
      </div>
      <ProgressBar value={percentage} label="Estimate progress" hideLabel />
    </div>
  );
}

function RoutingBacktestConfirmDialog({
  subject,
  range,
  estimate,
  billingHref,
  onCancel,
  onStarted,
}: {
  subject: RoutingBacktestSubject;
  range: RoutingBacktestRange;
  estimate: ModelRoutingBacktestEstimateV1;
  billingHref: string;
  onCancel: () => void;
  onStarted: (backtest: ModelRoutingBacktestV1) => void;
}): JSX.Element {
  const brand = useSettingsBrand();
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(ROUTING_BACKTEST_ERROR_SCOPE);
  const fullAvailable =
    estimate.plannedTurnCount.full !== null &&
    estimate.estimatedCostUsd.full !== null;
  const [mode, setMode] = useState<ModelRoutingBacktestMode>('sample');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SettingsFailure | null>(null);
  const [needsCredits, setNeedsCredits] = useState(false);

  const planned =
    mode === 'full'
      ? (estimate.plannedTurnCount.full ?? 0)
      : estimate.plannedTurnCount.sample;
  const cost =
    mode === 'full'
      ? (estimate.estimatedCostUsd.full ?? 0)
      : estimate.estimatedCostUsd.sample;

  const start = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const created = await createRoutingBacktest(client, subject, range, mode);
      onStarted(created.backtest);
    } catch (err: unknown) {
      const code = err instanceof TeamApiError ? err.code : undefined;
      setNeedsCredits(code === 'insufficient_credits');
      // The route's codes keep their own copy; anything else gets the
      // generic action copy, never the route's text.
      const failure = errorCopy.actionFailure(err, {
        action: 'start the estimate',
      });
      const message = createErrorMessage(code, failure.copy);
      setError(message === failure.copy ? failure : { copy: message });
      setBusy(false);
    }
  };

  const payer =
    subject.kind === 'organization'
      ? 'your organization’s AI Credits'
      : 'your AI Credits';

  return (
    <DialogModal
      onClose={busy ? (): void => undefined : onCancel}
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      title="Estimate savings"
      maxWidth="md"
      dataTestId="routing-backtest-confirm"
    >
      <div className="flex flex-col gap-4 text-s fg-secondary">
        <p>
          To estimate this, {brand.displayName} sends the messages from these
          conversations to the routing service. It doesn’t keep them; we save
          only the model it picks and the costs.
        </p>
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium fg-primary">How many turns</p>
          <ChoiceList aria-label="How many turns" kind="radio">
            <ChoiceListRow
              kind="radio"
              selected={mode === 'sample'}
              onClick={() => setMode('sample')}
              data-testid="routing-backtest-mode-sample"
            >
              A sample of {formatCount(estimate.plannedTurnCount.sample)} turns
            </ChoiceListRow>
            {fullAvailable ? (
              <ChoiceListRow
                kind="radio"
                selected={mode === 'full'}
                onClick={() => setMode('full')}
                data-testid="routing-backtest-mode-full"
              >
                Every turn ({formatCount(estimate.plannedTurnCount.full ?? 0)})
              </ChoiceListRow>
            ) : null}
          </ChoiceList>
        </div>
        <p data-testid="routing-backtest-cost-estimate">
          Replays {formatCount(planned)} turns. About {formatUsd(cost)}, paid
          from {payer}.
        </p>
        {error ? (
          <Notice
            errorSource="routing-backtest-confirm-error"
            intent="destructive"
            data-testid="routing-backtest-confirm-error"
            actions={
              error.details !== undefined ? (
                <CopyDetailsButton details={error.details} />
              ) : undefined
            }
          >
            {error.copy}
            {needsCredits ? (
              <>
                {' '}
                <SettingsLink
                  href={billingHref}
                  className="fg-accent hover:underline"
                >
                  Add AI Credits
                </SettingsLink>
              </>
            ) : null}
          </Notice>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          <Button size="compact" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="compact"
            onClick={() => void start()}
            disabled={busy}
            aria-busy={busy}
            data-testid="routing-backtest-confirm-start"
          >
            {busy ? 'Starting…' : 'Start estimate'}
          </Button>
        </div>
      </div>
    </DialogModal>
  );
}

function RoutingBacktestResults({
  result,
  copy,
  rangeLabel,
  reveal,
}: {
  result: ModelRoutingBacktestResultV1;
  copy: RoutingBacktestCopy;
  rangeLabel: string;
  reveal: boolean;
}): JSX.Element {
  const savings = displayedSavings(result);
  const cards: TelemetryHeadlineCard[] = [
    {
      key: 'backtestSpent',
      label: copy.spentLabel,
      value: result.baselineCostUsd,
      previousValue: null,
      unit: 'currency',
    },
    {
      key: 'backtestAuto',
      label: 'With model routing (est.)',
      value: result.autoCostUsd,
      previousValue: null,
      unit: 'currency',
    },
    {
      key: 'backtestSaved',
      label: 'Saved',
      value: savings.usd,
      previousValue: null,
      unit: 'currency',
    },
  ];
  const series = [
    { key: 'actual', label: copy.spentLabel, color: BACKTEST_ACTUAL_COLOR },
    { key: 'auto', label: copy.autoLabel, color: BACKTEST_AUTO_COLOR },
  ] as const;
  const lineData = result.series.map((point) => ({
    bucket: point.bucketStartIso,
    actual: point.actualCostUsd,
    auto: point.autoCostUsd,
  }));
  const shareRows = modelShareRows(result.modelShare).map((row) => ({
    label: row.label,
    first: row.actual,
    second: row.auto,
    firstDetail: `${formatShare(row.actualCost)} of cost`,
    secondDetail: `${formatShare(row.autoCost)} of cost`,
  }));

  return (
    <div
      className={
        reveal ? 'flex flex-col gap-5 animate-slide-up' : 'flex flex-col gap-5'
      }
      data-testid="routing-backtest-results"
    >
      <HeadlineCards
        cards={cards}
        testId="routing-backtest-tiles"
        descriptions={{
          backtestSpent: 'Your actual spend over this range, at list price.',
          backtestAuto:
            'Estimated spend for the same work if model routing had picked each model. Includes the cost of picking.',
          backtestSaved:
            'The difference between what you spent and the estimate with model routing.',
        }}
        cardDetails={{
          backtestSpent: { caption: rangeLabel },
          backtestAuto: { caption: 'Same work' },
          backtestSaved: {
            value: formatShare(savings.fraction),
            tone: 'success',
            caption: formatUsd(savings.usd),
          },
        }}
      />
      <section className="flex flex-col gap-2">
        <div className="flex flex-col gap-0.5">
          <Heading level={4} variant="title">
            {result.bucketGranularity === 'week'
              ? 'Weekly spend'
              : 'Daily spend'}
          </Heading>
          <p
            className="text-xs fg-secondary"
            data-testid="routing-backtest-spend-description"
          >
            Actual spend versus the estimate with model routing
          </p>
        </div>
        <Suspense fallback={null}>
          <ComparisonLineChart
            data={lineData}
            bucketKey="bucket"
            granularity={result.bucketGranularity}
            series={series}
            valueFormatter={formatUsd}
            ariaLabel="Spend with and without model routing"
            testId="routing-backtest-spend-chart"
          />
        </Suspense>
      </section>
      <section className="flex flex-col gap-2">
        <div className="flex flex-col gap-0.5">
          <Heading level={4} variant="title">
            Which models answered
          </Heading>
          <p
            className="text-xs fg-secondary"
            data-testid="routing-backtest-model-share-description"
          >
            The share of activity handled by each model with model routing.
          </p>
        </div>
        <Suspense fallback={null}>
          <PairedCategoryBarChart
            data={shareRows}
            series={[
              {
                key: 'first',
                label: copy.ranLabel,
                color: BACKTEST_ACTUAL_COLOR,
              },
              {
                key: 'second',
                label: copy.autoLabel,
                color: BACKTEST_AUTO_COLOR,
              },
            ]}
            valueFormatter={formatShare}
            ariaLabel="Share of turns by model"
            testId="routing-backtest-model-share-chart"
          />
        </Suspense>
      </section>
      {result.shifts.length > 0 ? (
        <Disclosure label="Details" dataTestId="routing-backtest-details">
          <DataTable
            caption="Turns routed to another model"
            rows={result.shifts}
            rowKey={(shift) => `${shift.fromModelId}->${shift.toModelId}`}
            columns={[
              {
                key: 'from',
                header: 'What ran',
                render: (shift) => modelLabel(shift.fromModelId),
              },
              {
                key: 'to',
                header: 'Routed to',
                render: (shift) => modelLabel(shift.toModelId),
              },
              {
                key: 'turns',
                header: 'Turns',
                align: 'right',
                render: (shift) => formatCount(shift.turnCount),
              },
              {
                key: 'cost',
                header: 'Cost',
                align: 'right',
                render: (shift) => formatUsd(shift.baselineCostUsd),
              },
            ]}
          />
        </Disclosure>
      ) : null}
    </div>
  );
}
