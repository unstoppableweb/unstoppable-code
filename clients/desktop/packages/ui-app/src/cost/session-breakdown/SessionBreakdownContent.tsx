'use client';

import { useId, useState, type JSX, type ReactNode } from 'react';
import type { CostNavigator } from '@canopy/app-core';
import type {
  CostBackgroundRow,
  CostContextCategory,
  CostHelperKind,
  CostModelRow,
  CostScopeRef,
  SessionBreakdownView as SessionBreakdownViewValue,
} from '@canopy/protocol/cost-view';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { getTelemetryToolCategoryLabel } from '@canopy/ui-shared/lib/telemetry-tool-category';
import {
  Surface,
  ArchivedStateIcon,
  HeaderActionButton,
  SegmentedControl,
  SegmentsBar,
  ThinkingSpinner,
  Heading,
} from '@canopy/ui-shared/components';
import {
  billedOnlyToAiCredits,
  CONTEXT_SERIES_COLORS,
  COST_NOT_PRICED_LABEL,
  COST_SOURCE_COLORS,
  COST_SOURCE_LABELS,
  CostFreshness,
  CostObservedTotal,
  costSourceSegments,
  CostSplitBar,
  formatCostAmountIn,
  formatCostShare,
  formatCostTotalIn,
  USAGE_SERIES_NEUTRALS,
  useCostCurrency,
} from '@canopy/ui-shared/components/cost';
import { ValueRow } from '@canopy/ui-shared/components/settings/ValueRows';
import { ChevronRightMediumIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  formatDuration,
  formatTokenCount,
} from '@canopy/ui-shared/lib/format-usage';
import {
  CostBillingSection,
  CostDetailSection,
  CostValueRow,
  CostValueRows,
} from '../cost-detail-parts';
import { AttributedCostRow } from './AttributedCostRow';

const CHAT_SOURCES = [
  'chat',
  'subagents',
  'delegations',
  'background',
] as const;

const BACKGROUND_KIND_LABELS: Readonly<Record<CostHelperKind, string>> = {
  chat_title: 'Chat title',
  branch_name: 'Branch name',
  handoff_summary: 'Handoff summary',
  commit_message: 'Commit messages',
  entry_summary: 'Entry summary',
  pull_request_text: 'Pull request text',
  pipeline_advisor: 'Workflow Advisor',
  other: 'Other',
};

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function modelList(models: readonly string[]): string {
  if (models.length <= 1) return models[0] ?? '';
  const finalModel = models[models.length - 1];
  if (finalModel === undefined) return models.join(', ');
  if (models.length === 2) return `${models[0]} and ${finalModel}`;
  return `${models.slice(0, -1).join(', ')} and ${finalModel}`;
}

function ModelRows({
  rows,
  total,
  showTurns,
}: {
  readonly rows: readonly CostModelRow[];
  readonly total: number;
  readonly showTurns: boolean;
}): JSX.Element {
  const currency = useCostCurrency();
  return (
    <CostValueRows>
      {rows.map((row) => (
        <CostValueRow
          key={row.model}
          label={row.model}
          note={
            showTurns
              ? plural(row.turnCount, 'turn', 'turns')
              : formatCostShare(row.usd, total)
          }
          value={formatCostTotalIn(row, currency)}
        />
      ))}
    </CostValueRows>
  );
}

function BackgroundItemRow({
  row,
}: {
  readonly row: CostBackgroundRow;
}): JSX.Element {
  const currency = useCostCurrency();
  const amount =
    row.usd === 0 && row.notPricedCount > 0
      ? COST_NOT_PRICED_LABEL
      : formatCostAmountIn(row.usd, currency);
  return (
    <li className="flex items-baseline gap-3 px-2 py-1 text-xs">
      <span className="fg-primary">{BACKGROUND_KIND_LABELS[row.kind]}</span>
      <span className="tabular-nums fg-tertiary">
        {plural(row.runCount, 'run', 'runs')}
      </span>
      <span className="ml-auto shrink-0 tabular-nums fg-secondary">
        {amount}
      </span>
    </li>
  );
}

function SourceRow({
  source,
  amount,
  count,
  details,
}: {
  readonly source: (typeof CHAT_SOURCES)[number];
  readonly amount: number;
  readonly count: string;
  readonly details?: ReactNode;
}): JSX.Element {
  const currency = useCostCurrency();
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const canExpand = details !== undefined;
  const rowContent = (
    <>
      <span className="flex size-4 shrink-0 items-center justify-center fg-tertiary">
        {canExpand ? (
          <ChevronRightMediumIcon
            size={16}
            aria-hidden="true"
            className={`transition-transform duration-150 motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`}
          />
        ) : null}
      </span>
      <span
        aria-hidden="true"
        className="size-2 shrink-0 rounded-xs"
        style={{ backgroundColor: COST_SOURCE_COLORS[source] }}
      />
      <span className="fg-primary">{COST_SOURCE_LABELS[source]}</span>
      <span className="tabular-nums fg-tertiary">{count}</span>
      <span className="ml-auto shrink-0 tabular-nums fg-primary">
        {formatCostAmountIn(amount, currency)}
      </span>
    </>
  );

  return (
    <div className="flex flex-col">
      {canExpand ? (
        <button
          type="button"
          data-testid={`session-breakdown-source-${source}`}
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={(): void => setExpanded((previous) => !previous)}
          className="focus-ring flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left text-xs transition-colors hover:bg-subtle pointer-coarse:min-h-11"
        >
          {rowContent}
        </button>
      ) : (
        <div
          data-testid={`session-breakdown-source-${source}`}
          className="flex items-center gap-2 px-1 py-1.5 text-xs"
        >
          {rowContent}
        </div>
      )}
      {canExpand ? (
        <div
          id={detailsId}
          hidden={!expanded}
          className="flex flex-col pb-1 pl-9"
        >
          {details}
        </div>
      ) : null}
    </div>
  );
}

function WhereItWent({
  view,
  navigator,
  scope,
  chatId,
}: {
  readonly view: SessionBreakdownViewValue;
  readonly navigator: CostNavigator;
  readonly scope: CostScopeRef;
  readonly chatId: string;
}): JSX.Element {
  const currency = useCostCurrency();
  const { bySource } = view;
  const subagents = bySource.subagents.items;
  const delegations = bySource.delegations.items;
  const backgroundRows = bySource.background.rows;
  // An included item's cost is part of the turns that started it. Chat turns
  // holds what is left after those shares, so the whole is the two together.
  const turnsWithIncludedUsd = [...subagents, ...delegations].reduce(
    (sum, item) =>
      item.inclusion === 'included' && item.usd !== undefined
        ? sum + item.usd
        : sum,
    bySource.chat.usd,
  );
  const chatTurnsDetails =
    view.chatTurnsByModel.length > 1 ? (
      <ModelRows
        rows={view.chatTurnsByModel}
        total={view.chat.totals.usd}
        showTurns
      />
    ) : undefined;

  const subagentDetails =
    subagents.length > 0 ? (
      <ul className="flex flex-col">
        {subagents.map((item) => (
          <li key={item.id}>
            <AttributedCostRow
              item={item}
              parentCost={turnsWithIncludedUsd}
              testId={`session-breakdown-item-${item.id}`}
              onOpen={
                navigator.openSubagent === undefined
                  ? undefined
                  : (): void => {
                      navigator.openSubagent?.(scope, {
                        chatId,
                        subagentId: item.id,
                        kind: item.kind,
                      });
                    }
              }
            />
          </li>
        ))}
      </ul>
    ) : undefined;

  const delegationDetails =
    delegations.length > 0 ? (
      <ul className="flex flex-col">
        {delegations.map((item) => (
          <li key={item.id}>
            <AttributedCostRow
              item={item}
              parentCost={turnsWithIncludedUsd}
              testId={`session-breakdown-item-${item.id}`}
              onOpen={
                navigator.openSubagent === undefined
                  ? undefined
                  : (): void => {
                      navigator.openSubagent?.(scope, {
                        chatId,
                        subagentId: item.id,
                        kind: item.kind,
                      });
                    }
              }
            />
          </li>
        ))}
      </ul>
    ) : undefined;

  const backgroundDetails =
    backgroundRows.length > 0 ? (
      <ul className="flex flex-col">
        {backgroundRows.map((row, index) => (
          <BackgroundItemRow key={`${row.kind}-${index}`} row={row} />
        ))}
      </ul>
    ) : undefined;

  return (
    <CostDetailSection
      title="Where it went"
      aside={formatCostAmountIn(
        view.chat.totals.usd,
        currency,
        billedOnlyToAiCredits(view.chat.totals.byBilling),
      )}
      testId="session-breakdown-where-it-went"
    >
      <CostSplitBar
        segments={costSourceSegments(view.chat.totals.bySource, CHAT_SOURCES)}
        label="Cost by source"
        size="summary"
      />
      <div className="flex flex-col">
        <SourceRow
          source="chat"
          amount={bySource.chat.usd}
          count={plural(view.chat.turnCount, 'turn', 'turns')}
          details={chatTurnsDetails}
        />
        <SourceRow
          source="subagents"
          amount={bySource.subagents.usd}
          count={plural(subagents.length, 'run', 'runs')}
          details={subagentDetails}
        />
        <SourceRow
          source="delegations"
          amount={bySource.delegations.usd}
          count={plural(delegations.length, 'delegate', 'delegates')}
          details={delegationDetails}
        />
        <SourceRow
          source="background"
          amount={bySource.background.usd}
          count={plural(backgroundRows.length, 'task', 'tasks')}
          details={backgroundDetails}
        />
      </div>
    </CostDetailSection>
  );
}

function Tokens({
  view,
}: {
  readonly view: SessionBreakdownViewValue;
}): JSX.Element {
  const { tokens } = view.chat.totals;
  return (
    <CostDetailSection title="Tokens" testId="session-breakdown-tokens">
      <CostValueRows>
        <CostValueRow label="Input" value={formatTokenCount(tokens.input)} />
        <CostValueRow label="Output" value={formatTokenCount(tokens.output)} />
        <CostValueRow
          label="Reasoning"
          note="Part of output"
          value={formatTokenCount(tokens.reasoningOutputTokens)}
        />
        <CostValueRow
          label="Cache read"
          value={formatTokenCount(tokens.cacheReadInputTokens)}
        />
        <CostValueRow
          label="Cache write"
          value={formatTokenCount(tokens.cacheCreationInputTokens)}
        />
      </CostValueRows>
    </CostDetailSection>
  );
}

function CostTab({
  view,
  navigator,
  scope,
  chatId,
}: {
  readonly view: SessionBreakdownViewValue;
  readonly navigator: CostNavigator;
  readonly scope: CostScopeRef;
  readonly chatId: string;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <WhereItWent
        view={view}
        navigator={navigator}
        scope={scope}
        chatId={chatId}
      />
      <CostBillingSection totals={view.chat.totals} label="Cost by billing" />
      <Tokens view={view} />
    </div>
  );
}

function categoryColor(
  category: CostContextCategory,
  usedIndex: number,
): string {
  if (category.kind === 'used') {
    return (
      CONTEXT_SERIES_COLORS[usedIndex % CONTEXT_SERIES_COLORS.length] ??
      USAGE_SERIES_NEUTRALS.secondary
    );
  }
  if (category.kind === 'buffer') return USAGE_SERIES_NEUTRALS.tertiary;
  return 'var(--bg-muted)';
}

function contextSegments(categories: readonly CostContextCategory[]): {
  readonly name: string;
  readonly tokens: number;
  readonly color: string;
}[] {
  let usedIndex = 0;
  return categories
    .filter(
      (category) => category.kind !== 'deferred' && category.kind !== 'free',
    )
    .map((category) => {
      const color = categoryColor(category, usedIndex);
      if (category.kind === 'used') usedIndex += 1;
      return { name: category.name, tokens: category.tokens, color };
    });
}

function contextCategoryShare(tokens: number, windowTokens: number): string {
  const share = windowTokens > 0 ? (tokens / windowTokens) * 100 : 0;
  if (share > 0 && share < 0.1) return '<0.1%';
  return `${share.toFixed(1)}%`;
}

function ContextMeter({
  view,
}: {
  readonly view: SessionBreakdownViewValue;
}): JSX.Element {
  const latest = view.context.latest;
  if (latest === undefined) return <></>;
  const segments = contextSegments(view.context.categories);
  const contextBarSegments =
    segments.length > 0
      ? segments.map((segment) => ({
          key: segment.name,
          label: segment.name,
          value: segment.tokens,
          color: segment.color,
        }))
      : [
          {
            key: 'context',
            label: 'Context',
            value: latest.usedTokens,
            color: CONTEXT_SERIES_COLORS[0] ?? USAGE_SERIES_NEUTRALS.secondary,
          },
        ];
  const categorizedTokens = contextBarSegments.reduce(
    (sum, segment) => sum + segment.value,
    0,
  );
  const scale =
    latest.windowTokens > 0
      ? Math.min(categorizedTokens / latest.windowTokens, 1)
      : 0;
  const description = contextBarSegments
    .map(
      (segment) => `${segment.label} ${formatTokenCount(segment.value)} tokens`,
    )
    .join(', ');

  return (
    <SegmentsBar
      segments={contextBarSegments}
      scale={scale}
      label={`Context window by category: ${description}`}
    />
  );
}

function ContextList({
  view,
}: {
  readonly view: SessionBreakdownViewValue;
}): JSX.Element | null {
  const latest = view.context.latest;
  if (latest === undefined) return null;
  const categories = view.context.categories.filter(
    (category) => category.kind !== 'deferred',
  );
  if (categories.length === 0) return null;
  let usedIndex = 0;

  return (
    <CostValueRows>
      {categories.map((category) => {
        const color = categoryColor(category, usedIndex);
        if (category.kind === 'used') usedIndex += 1;
        return (
          <ValueRow
            key={category.name}
            swatch={color}
            label={category.name}
            value={formatTokenCount(category.tokens)}
            share={contextCategoryShare(category.tokens, latest.windowTokens)}
          />
        );
      })}
    </CostValueRows>
  );
}

function compactionLabel(view: SessionBreakdownViewValue): string {
  const { total, auto, manual } = view.compactions;
  if (total === 0) return 'None';
  const parts = [
    auto > 0 ? plural(auto, 'automatic', 'automatic') : null,
    manual > 0 ? plural(manual, 'manual', 'manual') : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? String(total) : `${total}: ${parts.join(', ')}`;
}

function ContextTimeline({
  view,
}: {
  readonly view: SessionBreakdownViewValue;
}): JSX.Element | null {
  const points = view.context.timeline;
  const latest = view.context.latest;
  if (points.length === 0 || latest === undefined) return null;

  const lastX = Math.max(points.length - 1, 1);
  const markers = points
    .map((point, index) => ({ point, index }))
    .filter(({ point }) => point.compaction !== undefined);
  const polyline = points
    .map((point, index) => {
      const y =
        100 -
        (latest.windowTokens > 0
          ? (point.endTokens / latest.windowTokens) * 100
          : 0);
      return `${index},${y}`;
    })
    .join(' ');

  return (
    <div className="flex flex-col gap-1">
      <div className="relative h-16 w-full rounded-sm bg-muted">
        <svg
          viewBox={`0 0 ${lastX} 100`}
          preserveAspectRatio="none"
          className="absolute inset-0 size-full overflow-visible"
          role="img"
          aria-label={`Context at the end of each turn, ${view.compactions.total} compactions`}
        >
          {markers.map(({ point, index }) => (
            <line
              key={`${point.at}-${index}`}
              x1={index}
              x2={index}
              y1={0}
              y2={100}
              stroke="currentColor"
              strokeWidth={1}
              strokeDasharray={
                point.compaction === 'manual' ? '2 3' : undefined
              }
              vectorEffect="non-scaling-stroke"
              className="fg-tertiary"
            />
          ))}
          <polyline
            points={polyline}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            className="fg-accent"
          />
        </svg>
      </div>
      <div className="flex justify-between text-2xs tabular-nums fg-tertiary">
        <span>Turn 1</span>
        <span>{`Turn ${points.length}`}</span>
      </div>
      <p className="text-xs fg-tertiary">
        Lines mark compactions; a dashed line was started by hand.
      </p>
    </div>
  );
}

function ContextSection({
  view,
}: {
  readonly view: SessionBreakdownViewValue;
}): JSX.Element {
  const latest = view.context.latest;
  if (latest === undefined) {
    return (
      <CostDetailSection title="Context" testId="session-breakdown-context">
        <p className="text-xs fg-tertiary">
          No context reported for this chat.
        </p>
      </CostDetailSection>
    );
  }

  const peak = view.context.peak;
  return (
    <CostDetailSection
      title="Context"
      aside={`${formatTokenCount(latest.usedTokens)} / ${formatTokenCount(latest.windowTokens)} (${formatCostShare(latest.usedTokens, latest.windowTokens)})`}
      testId="session-breakdown-context"
    >
      <ContextMeter view={view} />
      <ContextList view={view} />
      <CostValueRows>
        {peak !== undefined ? (
          <CostValueRow
            label="Peak"
            value={`${formatTokenCount(peak.usedTokens)} of ${formatTokenCount(peak.windowTokens)}`}
          />
        ) : null}
        <CostValueRow label="Compactions" value={compactionLabel(view)} />
      </CostValueRows>
      <ContextTimeline view={view} />
    </CostDetailSection>
  );
}

function StatRows({
  stats,
}: {
  readonly stats: readonly (readonly [string, string])[];
}): JSX.Element {
  return (
    <CostValueRows>
      {stats.map(([label, value]) => (
        <CostValueRow key={label} label={label} value={value} />
      ))}
    </CostValueRows>
  );
}

/** The tool group that counts the app's own tools, under its wire name. */
const APP_TOOLS_GROUP = 'canopy';

/** A tool group's name: the app's own tools carry the host's app name. */
function toolGroupLabel(tool: string, appName: string | undefined): string {
  return tool === APP_TOOLS_GROUP && appName !== undefined
    ? appName
    : getTelemetryToolCategoryLabel(tool);
}

function ActivitySection({
  view,
  appName,
}: {
  readonly view: SessionBreakdownViewValue;
  readonly appName: string | undefined;
}): JSX.Element {
  const activity = view.activity;
  const plans =
    activity.plansCreated === 0
      ? 'None'
      : `${activity.plansCreated} created, ${activity.plansApproved} approved`;
  const averageTurn =
    activity.averageTurnMs === null
      ? 'None'
      : formatDuration(activity.averageTurnMs);
  const p95Turn =
    activity.p95TurnMs === null ? 'None' : formatDuration(activity.p95TurnMs);
  const toolCallsPerTurn =
    activity.turnCount === 0
      ? '0.0'
      : (activity.toolCallCount / activity.turnCount).toFixed(1);

  return (
    <div className="flex flex-col gap-6">
      <CostDetailSection title="Activity" testId="session-breakdown-activity">
        <StatRows
          stats={[
            ['Turns', String(activity.turnCount)],
            ['Total time', formatDuration(activity.totalDurationMs)],
            ['Average turn', averageTurn],
            ['P95 turn', p95Turn],
            ['Tool calls', String(activity.toolCallCount)],
            ['Per turn', toolCallsPerTurn],
            ['Subagents', String(activity.subagentCount)],
            ['Plans', plans],
          ]}
        />
      </CostDetailSection>
      <CostDetailSection title="Top tools" testId="session-breakdown-top-tools">
        <CostValueRows>
          {activity.topTools.map((tool) => (
            <CostValueRow
              key={tool.tool}
              label={toolGroupLabel(tool.tool, appName)}
              value={String(tool.count)}
            />
          ))}
        </CostValueRows>
      </CostDetailSection>
      <CostDetailSection title="By model" testId="session-breakdown-by-model">
        <ModelRows
          rows={view.byModel}
          total={view.chat.totals.usd}
          showTurns={false}
        />
      </CostDetailSection>
    </div>
  );
}

export type SessionBreakdownTab = 'cost' | 'context' | 'activity';

export interface SessionBreakdownContentProps {
  readonly view: SessionBreakdownViewValue;
  readonly navigator: CostNavigator;
  readonly scope: CostScopeRef;
  readonly chatId: string;
  readonly sealed: boolean;
  readonly initialTab: SessionBreakdownTab;
  readonly updatedAt: string | null;
  readonly refreshing: boolean;
  readonly refreshProblemMessage: string | null;
  readonly completedRefreshes: number;
  readonly onRefresh: () => void;
  readonly now?: number;
  /** The host's app name, for the group that counts the app's own tools. */
  readonly appName?: string;
}

function ChatStateMarker({
  view,
  sealed,
}: {
  readonly view: SessionBreakdownViewValue;
  readonly sealed: boolean;
}): JSX.Element | null {
  if (view.chat.state === 'archived') {
    return (
      <span className="flex shrink-0 items-center gap-1 text-xs fg-secondary">
        <ArchivedStateIcon state="archived" size="sm" />
        Archived
      </span>
    );
  }
  if (sealed || !view.chat.running) return null;
  return (
    <span className="flex shrink-0 items-center gap-1 text-xs fg-secondary">
      <ThinkingSpinner sizePx={12} tone="accent" />
      Running
    </span>
  );
}

function Header({
  view,
  navigator,
  scope,
  chatId,
  sealed,
  updatedAt,
  refreshing,
  refreshProblemMessage,
  completedRefreshes,
  onRefresh,
  now,
}: SessionBreakdownContentProps): JSX.Element {
  const currency = useCostCurrency();
  const models = modelList(view.chat.models);
  const metaSuffix = [
    plural(view.chat.turnCount, 'turn', 'turns'),
    ...(models.length > 0 ? [models] : []),
  ].join(' · ');
  const sealedAt = view.sealedAt ?? updatedAt ?? view.updatedAt;
  const openChat = (): void => {
    navigator.openChat?.(scope, chatId);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          {/* A chat's name is user-written: masked in session replay, and
              in no attribute, which replay would record as written. */}
          <Heading level={2} variant="title" truncate className="min-w-0">
            <span className={REPLAY_MASK_CLASS}>{view.chat.label}</span>
          </Heading>
          <ChatStateMarker view={view} sealed={sealed} />
        </div>
        <div
          data-testid="session-breakdown-meta"
          className="flex min-w-0 items-baseline gap-1.5 text-xs tabular-nums"
        >
          <CostObservedTotal
            amountLabel={formatCostTotalIn(view.chat.totals, currency)}
            coverageStart={view.chat.coverageStart}
            size="inline"
            testId="session-breakdown-observed-total"
          />
          <span className="min-w-0 truncate fg-tertiary">· {metaSuffix}</span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        {!sealed && navigator.openChat !== undefined ? (
          <HeaderActionButton
            tone="neutral"
            data-testid="session-breakdown-open-chat"
            onClick={openChat}
          >
            Open chat
          </HeaderActionButton>
        ) : null}
        <div className="ml-auto">
          <CostFreshness
            updatedAt={sealed ? null : updatedAt}
            now={now}
            refreshing={!sealed && refreshing}
            failureReason={sealed ? null : refreshProblemMessage}
            sealedAt={sealed ? (sealedAt ?? undefined) : undefined}
            onRefresh={sealed ? undefined : onRefresh}
            completedRefreshes={completedRefreshes}
          />
        </div>
      </div>
    </div>
  );
}

export function SessionBreakdownContent({
  view,
  navigator,
  scope,
  chatId,
  sealed,
  initialTab,
  updatedAt,
  refreshing,
  refreshProblemMessage,
  completedRefreshes,
  onRefresh,
  now,
  appName,
}: SessionBreakdownContentProps): JSX.Element {
  const [tab, setTab] = useState<SessionBreakdownTab>(initialTab);
  const tabsId = useId();
  const panelId = `${tabsId}-panel`;
  const handleRefresh = (): void => onRefresh();

  return (
    <Surface
      variant="pane"
      extent="parent"
      data-testid="session-breakdown-view"
      className="flex min-h-0 w-full flex-col"
    >
      {/* The header and tabs stay in view; only the chosen tab scrolls. */}
      <div className="flex w-full max-w-2xl shrink-0 flex-col gap-6 px-3 pt-3">
        <Header
          view={view}
          navigator={navigator}
          scope={scope}
          chatId={chatId}
          sealed={sealed}
          initialTab={initialTab}
          updatedAt={updatedAt}
          refreshing={refreshing}
          refreshProblemMessage={refreshProblemMessage}
          completedRefreshes={completedRefreshes}
          onRefresh={handleRefresh}
          now={now}
        />
        <SegmentedControl
          value={tab}
          options={[
            {
              value: 'cost',
              label: 'Cost',
              dataTestId: 'session-breakdown-tab-cost',
              id: `${tabsId}-cost`,
              controls: panelId,
            },
            {
              value: 'context',
              label: 'Context',
              dataTestId: 'session-breakdown-tab-context',
              id: `${tabsId}-context`,
              controls: panelId,
            },
            {
              value: 'activity',
              label: 'Activity',
              dataTestId: 'session-breakdown-tab-activity',
              id: `${tabsId}-activity`,
              controls: panelId,
            },
          ]}
          onChange={setTab}
          label="Session breakdown"
          semantics="tabs"
          width="fill"
          dataTestId="session-breakdown-tabs"
        />
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        data-testid="session-breakdown-scroll"
      >
        <div
          id={panelId}
          role="tabpanel"
          aria-labelledby={`${tabsId}-${tab}`}
          data-testid={`session-breakdown-panel-${tab}`}
          className="flex w-full max-w-2xl flex-col gap-6 px-3 pb-3 pt-6"
        >
          {tab === 'cost' ? (
            <CostTab
              view={view}
              navigator={navigator}
              scope={scope}
              chatId={chatId}
            />
          ) : tab === 'context' ? (
            <ContextSection view={view} />
          ) : (
            <ActivitySection view={view} appName={appName} />
          )}
        </div>
      </div>
    </Surface>
  );
}
