import { type JSX, useEffect, useMemo, useRef, useState } from 'react';
import { CHAT_UNIT_LABEL } from '@canopy/protocol';
import type {
  AgentAuditHistoryResponse,
  AgentAuditEntry,
} from '@canopy/desktop-shared/types';
import { brandText } from '@/lib/brand';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { useObservabilityEntriesInterest } from '@/lib/chat-interest';
import {
  Stack,
  CenteredLoadingSpinner,
  DelayedLoadingPlaceholder,
  Heading,
  Notice,
  SegmentedControl,
  SegmentsBar,
  type SegmentedControlOption,
  Surface,
} from '@canopy/ui-shared/components';
import { useFlipBox } from '@canopy/ui-shared/lib';
import { formatDurationMs, formatNumber } from './format';
import { buildTodayData, type TodayData } from './today-statistics-data';

type DetailMode = 'repos' | 'providers' | 'tools' | 'pipelines';

interface TodayWindow {
  key: string;
  start: string;
  end: string;
}

interface TodayHistoryLoadResult {
  entries: AgentAuditEntry[];
  truncated: boolean;
}

const DETAIL_MODES: readonly SegmentedControlOption<DetailMode>[] = [
  { value: 'repos', label: 'PRs' },
  { value: 'providers', label: 'Turns' },
  { value: 'tools', label: 'Tools' },
  { value: 'pipelines', label: 'Workflows' },
];

const SEGMENT_COLORS = {
  chats: 'var(--fg-accent)',
  prs: 'var(--fg-success)',
  pipelines: 'var(--fg-warning)',
  tools: 'var(--bg-accent-subtle)',
  tokens: 'var(--fg-info)',
} as const;

// Defensive upper bound: with limit=500 per page, this caps the loop at
// 25 000 entries - well above any realistic single-day audit volume - so a
// backend regression that returns a perpetual cursor cannot hang the panel.
const MAX_HISTORY_PAGES = 50;

const DETAIL_MODE_COLORS: Record<DetailMode, string> = {
  repos: 'var(--fg-success)',
  providers: 'var(--fg-accent)',
  tools: 'var(--bg-accent-subtle)',
  pipelines: 'var(--fg-warning)',
};

function startOfToday(): Date {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function endOfToday(start: Date): Date {
  const date = new Date(start);
  date.setDate(date.getDate() + 1);
  return date;
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getTodayWindow(): TodayWindow {
  const start = startOfToday();
  const end = endOfToday(start);
  return {
    key: localDateKey(start),
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

async function loadAllTodayHistory(
  todayWindow: TodayWindow,
): Promise<TodayHistoryLoadResult> {
  const entries: AgentAuditEntry[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
    const response: AgentAuditHistoryResponse =
      await window.api.observability.loadHistory({
        startDate: todayWindow.start,
        endDate: todayWindow.end,
        status: 'success',
        limit: 500,
        cursor,
      });
    entries.push(...response.entries);
    cursor = response.nextCursor;
    if (!cursor) break;
  }

  return { entries, truncated: Boolean(cursor) };
}

function StatTile({
  label,
  value,
  detail,
  accent,
}: {
  label: string;
  value: string;
  detail: string;
  accent: string;
}): JSX.Element {
  return (
    <Surface variant="card" gap="item" padding="default">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs font-medium fg-secondary">{label}</div>
        <span
          aria-hidden="true"
          className="h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: accent }}
        />
      </div>
      <Stack gap="tight">
        <div className="text-2xl font-semibold fg-primary">{value}</div>
        <div className="text-xs fg-secondary">{detail}</div>
      </Stack>
    </Surface>
  );
}

/** A bar's fill: a compositor stretch on the Tailwind default curve. */
const BAR_FILL = {
  durationMs: 150,
  easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const;

function ActivityBar({
  label,
  value,
  max,
  color,
}: {
  label: string;
  value: number;
  max: number;
  color: string;
}): JSX.Element {
  const width = max > 0 ? Math.max(6, Math.round((value / max) * 100)) : 0;
  const barRef = useRef<HTMLDivElement>(null);
  useFlipBox(barRef, BAR_FILL);
  return (
    <Stack gap="tight">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="truncate fg-primary">{label}</span>
        <span className="shrink-0 tabular-nums fg-secondary">
          {formatNumber(value)}
        </span>
      </div>
      <SegmentsBar
        segments={[{ key: label, value, color }]}
        scale={width / 100}
        size="large"
        fillRef={barRef}
      />
    </Stack>
  );
}

export function TodayStatisticsPanel(): JSX.Element {
  useObservabilityEntriesInterest();
  const loadUsageMetricsView = useObservabilityStore(
    (s) => s.loadUsageMetricsView,
  );
  const usageMetricsViewVersion = useObservabilityStore(
    (s) => s.usageMetricsViewVersion,
  );
  const [mode, setMode] = useState<DetailMode>('repos');
  const [data, setData] = useState<TodayData | null>(null);
  const [historyTruncated, setHistoryTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [todayWindow, setTodayWindow] = useState<TodayWindow>(() =>
    getTodayWindow(),
  );

  useEffect(() => {
    const now = new Date();
    const nextMidnight = endOfToday(startOfToday()).getTime();
    const timeout = window.setTimeout(
      () => setTodayWindow(getTodayWindow()),
      Math.max(1, nextMidnight - now.getTime()),
    );
    return (): void => window.clearTimeout(timeout);
  }, [todayWindow.key]);

  useEffect(() => {
    let cancelled = false;
    setError(null);

    const localStatsPromise = Promise.all([
      loadAllTodayHistory(todayWindow),
      loadUsageMetricsView({
        tab: 'chats',
        metric: 'chat_turns',
        groupBy: 'provider',
        window: {
          kind: 'custom',
          start: todayWindow.start,
          end: todayWindow.end,
        },
      }),
      loadUsageMetricsView({
        tab: 'tools',
        metric: 'tool_calls',
        groupBy: 'category',
        window: {
          kind: 'custom',
          start: todayWindow.start,
          end: todayWindow.end,
        },
      }),
    ]);

    localStatsPromise
      .then(([history, chatProviders, toolsByCategory]) => {
        if (cancelled) return;
        setHistoryTruncated(history.truncated);
        setData(
          buildTodayData(history.entries, chatProviders, toolsByCategory),
        );
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(
          reason instanceof Error
            ? reason.message
            : 'Failed to load today statistics',
        );
      });

    return (): void => {
      cancelled = true;
    };
  }, [loadUsageMetricsView, todayWindow, usageMetricsViewVersion]);

  const activeRows = useMemo(() => {
    if (!data) return [];
    if (mode === 'repos') {
      return data.repoRows.map((row) => ({
        key: row.key,
        label: row.label,
        count: row.count,
      }));
    }
    if (mode === 'providers') {
      return data.providerRows.map((row) => ({
        key: row.key,
        label: row.label,
        count: row.count,
      }));
    }
    if (mode === 'tools') {
      return data.toolRows.map((row) => ({
        key: row.key,
        label: row.label,
        count: row.count,
      }));
    }
    return data.pipelineRows.map((row) => ({
      key: row.key,
      label: row.label,
      count: row.count,
    }));
  }, [data, mode]);

  const maxRowValue = Math.max(0, ...activeRows.map((row) => row.count));
  const totalActivity =
    data === null
      ? 0
      : data.stats.chatTurns +
        data.stats.prs +
        data.stats.pipelines +
        data.stats.tools;
  const donutSegments = useMemo(
    () =>
      data === null
        ? []
        : [
            {
              label: `${CHAT_UNIT_LABEL} turns`,
              value: data.stats.chatTurns,
              color: SEGMENT_COLORS.chats,
            },
            { label: 'PRs', value: data.stats.prs, color: SEGMENT_COLORS.prs },
            {
              label: 'Workflows',
              value: data.stats.pipelines,
              color: SEGMENT_COLORS.pipelines,
            },
            {
              label: 'Tools',
              value: data.stats.tools,
              color: SEGMENT_COLORS.tools,
            },
          ],
    [data],
  );
  const gradient = useMemo(() => {
    if (totalActivity === 0) {
      return 'conic-gradient(var(--bg-secondary) 0 100%)';
    }

    const stops = donutSegments.reduce<{ acc: string[]; offset: number }>(
      ({ acc, offset }, segment) => {
        const end = offset + (segment.value / totalActivity) * 100;
        return {
          acc: [...acc, `${segment.color} ${offset}% ${end}%`],
          offset: end,
        };
      },
      { acc: [], offset: 0 },
    ).acc;

    return `conic-gradient(${stops.join(', ')})`;
  }, [donutSegments, totalActivity]);
  const detailBarColor = DETAIL_MODE_COLORS[mode];

  return (
    <section
      className="flex flex-col gap-4"
      data-testid="statistics-today-panel"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Heading level={2} variant="section">
            Today's statistics
          </Heading>
          <p className="text-s fg-secondary">
            Activity since local midnight from local {brandText.appName}{' '}
            observability.
          </p>
        </div>
        <div className="rounded-full border bg-card px-3 py-1 text-xs fg-secondary">
          {new Date(todayWindow.start).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          })}
        </div>
      </div>

      {error ? (
        <Notice errorSource="today-statistics-panel" intent="destructive">
          {error}
        </Notice>
      ) : data === null ? (
        <Surface variant="card" padding="roomy">
          <DelayedLoadingPlaceholder slowNote="Still loading today…">
            <CenteredLoadingSpinner />
          </DelayedLoadingPlaceholder>
        </Surface>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <StatTile
              label="Total tokens"
              value={formatNumber(data.stats.tokens)}
              detail={`${formatNumber(data.stats.inputTokens)} in / ${formatNumber(
                data.stats.outputTokens,
              )} out`}
              accent={SEGMENT_COLORS.tokens}
            />
            <StatTile
              label="Agent PRs"
              value={formatNumber(data.stats.prs)}
              detail={`${formatNumber(data.stats.repos)} repos with new PRs`}
              accent={SEGMENT_COLORS.prs}
            />
            <StatTile
              label={`${CHAT_UNIT_LABEL} sessions`}
              value={formatNumber(data.stats.chats)}
              detail={`${formatNumber(data.stats.chatTurns)} completed turns`}
              accent={SEGMENT_COLORS.chats}
            />
            <StatTile
              label="Workflows run"
              value={formatNumber(data.stats.pipelines)}
              detail={`${formatDurationMs(data.stats.durationMs)} agent time`}
              accent={SEGMENT_COLORS.pipelines}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
            <Surface variant="card" gap="group" padding="default">
              <div
                className="mx-auto grid h-48 w-48 place-items-center rounded-full"
                style={{ background: gradient }}
              >
                <div className="grid h-28 w-28 place-items-center rounded-full bg-card text-center">
                  <div>
                    <div className="text-2xl font-semibold fg-primary">
                      {formatNumber(totalActivity)}
                    </div>
                    <div className="text-xs fg-secondary">events</div>
                  </div>
                </div>
              </div>
              <div className="grid gap-2 text-xs fg-secondary">
                {donutSegments.map((segment) => (
                  <div
                    key={segment.label}
                    className="flex items-center justify-between gap-3"
                  >
                    <span className="inline-flex items-center gap-2">
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: segment.color }}
                      />
                      {segment.label}
                    </span>
                    <span className="tabular-nums">
                      {formatNumber(segment.value)}
                    </span>
                  </div>
                ))}
              </div>
            </Surface>

            <Surface variant="card" gap="group" padding="default">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Heading level={3} variant="title">
                  Detail Explorer
                </Heading>
                <SegmentedControl<DetailMode>
                  label="Detail explorer view"
                  value={mode}
                  width="content"
                  shape="capsule"
                  options={DETAIL_MODES}
                  onChange={setMode}
                />
              </div>
              <Stack gap="item">
                {activeRows.length === 0 ? (
                  <Surface variant="dashed" size="small">
                    <div className="px-4 py-8 text-center text-s fg-secondary">
                      Nothing recorded here today.
                    </div>
                  </Surface>
                ) : (
                  activeRows
                    .slice(0, 8)
                    .map((row) => (
                      <ActivityBar
                        key={row.key}
                        label={row.label}
                        value={row.count}
                        max={maxRowValue}
                        color={detailBarColor}
                      />
                    ))
                )}
              </Stack>
            </Surface>
          </div>
          {historyTruncated ? (
            <Notice intent="attention" role="none">
              Today has more audit history than the panel can load at once, so
              these totals may be partial.
            </Notice>
          ) : null}
        </>
      )}
    </section>
  );
}
