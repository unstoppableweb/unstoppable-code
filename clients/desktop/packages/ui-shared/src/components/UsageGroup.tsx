'use client';

import { useId, type JSX, type ReactNode } from 'react';
import { USAGE_ALERT_WARNING_THRESHOLD } from '@canopy/protocol/provider-usage';
import { ModelProviderIcon } from '../icons/ModelProviderIcon';
import { NoticeShapeProvider } from '../primitives/Notice';
import { formatRelativeTime } from '../lib/format-relative-time';
import { Button } from '../primitives/Button';
import { ProgressBar, type ProgressTone } from '../primitives/Progress';
import { RefreshSpinner } from './RefreshSpinner';
import { Tooltip } from '../primitives/Tooltip';
import { formatCreditsLeft } from './UsageIndicator';
import { formatUsagePercent } from './usage-indicator-meter';
import { Heading } from '../primitives/Heading';
import { Stack, type SpaceRole } from '../primitives/Stack';

/** One displayable plan limit window, as every usage surface receives it. */
export interface UsageLimitCard {
  key: string;
  title: string;
  unlimited?: boolean;
  usedPercent?: number;
  resetsAt?: string | number;
  windowDurationMs?: number;
  credits?: { usedUsd?: number; remainingUsd?: number; totalUsd?: number };
  spend?: {
    currency?: string;
    used?: number;
    limit?: number | null;
    isEnabled?: boolean;
  };
  creditsAreCount?: boolean;
}

function formatSpendMoney(
  amount: number | undefined,
  currency: string | undefined,
): string | undefined {
  if (
    amount === undefined ||
    !Number.isFinite(amount) ||
    !currency ||
    new Intl.DisplayNames('en', {
      type: 'currency',
      fallback: 'none',
    }).of(currency) === undefined
  ) {
    return undefined;
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(amount);
}

/**
 * A window turns red from here. Orange starts at the shared alert warning
 * threshold (80%); the Usage meters turn red earlier than the 98% alert so
 * the window that matters stands out before it blocks work.
 */
export const USAGE_METER_DANGER_THRESHOLD = 95;

export type UsageLevel = 'normal' | 'warning' | 'danger';

/** Meters stay neutral; only a window near its limit gets colour. */
export function usageLevel(usedPercent: number): UsageLevel {
  if (usedPercent >= USAGE_METER_DANGER_THRESHOLD) return 'danger';
  if (usedPercent >= USAGE_ALERT_WARNING_THRESHOLD) return 'warning';
  return 'normal';
}

const METER_TONE: Record<UsageLevel, ProgressTone> = {
  normal: 'neutral',
  warning: 'warning',
  danger: 'destructive',
};

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDayMs(ms: number): number {
  const day = new Date(ms);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/**
 * When a window resets, in words: `today at 5:10 AM`, `tomorrow at 7:00 AM`,
 * `Thu at 6:15 PM` within the week, otherwise the date (`Nov 8`). Null for a
 * missing or unreadable time.
 */
export function formatUsageResetPhrase(
  resetsAt: string | number | undefined,
  nowMs: number,
): string | null {
  if (resetsAt === undefined || resetsAt === '') return null;
  const date = new Date(resetsAt);
  const resetMs = date.getTime();
  if (!Number.isFinite(resetMs)) return null;
  const time = date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  const days = Math.round(
    (startOfDayMs(resetMs) - startOfDayMs(nowMs)) / DAY_MS,
  );
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  if (days > 1 && days < 7) {
    const weekday = date.toLocaleDateString(undefined, { weekday: 'short' });
    return `${weekday} at ${time}`;
  }
  const sameYear = date.getFullYear() === new Date(nowMs).getFullYear();
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/**
 * A plan as a group heading names it, without the provider in front:
 * `Max 20x` under Claude rather than `Claude Max 20x`.
 */
export function usagePlanLabel(
  providerLabel: string,
  plan: string | null | undefined,
): string | null {
  const trimmed = plan?.trim();
  if (!trimmed) return null;
  const prefix = `${providerLabel} `;
  return trimmed.length > prefix.length &&
    trimmed.toLowerCase().startsWith(prefix.toLowerCase())
    ? trimmed.slice(prefix.length)
    : trimmed;
}

/** `Updated just now`, `Updated 3m ago`; null before the first read. */
export function formatUsageUpdatedPhrase(
  updatedAt: string | number | null | undefined,
  nowMs: number,
): string | null {
  if (updatedAt === null || updatedAt === undefined || updatedAt === '') {
    return null;
  }
  const updatedMs = new Date(updatedAt).getTime();
  if (!Number.isFinite(updatedMs)) return null;
  if (nowMs - updatedMs < 60_000) return 'Updated just now';
  return `Updated ${formatRelativeTime(updatedMs, nowMs)}`;
}

/** The newest of several read times, or null when none is readable. */
export function newestUsageUpdate(
  times: ReadonlyArray<string | number | null | undefined>,
): number | null {
  let newest: number | null = null;
  for (const time of times) {
    if (time === null || time === undefined || time === '') continue;
    const ms = new Date(time).getTime();
    if (Number.isFinite(ms) && (newest === null || ms > newest)) newest = ms;
  }
  return newest;
}

function isResetPassed(
  resetsAt: string | number | undefined,
  nowMs: number,
): boolean {
  if (resetsAt === undefined || resetsAt === '') return false;
  const resetMs = new Date(resetsAt).getTime();
  return Number.isFinite(resetMs) && resetMs <= nowMs;
}

/**
 * How far through its window a limit is, 0–100, for the triangle under its
 * meter: usage left of the triangle is on pace to last the window. Undefined
 * without a reset time and window length, or once the reset has passed.
 */
export function usageWindowElapsedPercent(
  window: Pick<UsageLimitCard, 'resetsAt' | 'windowDurationMs'>,
  nowMs: number,
): number | undefined {
  const duration = window.windowDurationMs;
  if (window.resetsAt === undefined || window.resetsAt === '' || !duration) {
    return undefined;
  }
  const resetMs = new Date(window.resetsAt).getTime();
  if (!Number.isFinite(resetMs) || resetMs <= nowMs) return undefined;
  const percent = ((nowMs - (resetMs - duration)) / duration) * 100;
  if (!Number.isFinite(percent)) return undefined;
  return Math.max(0, Math.min(100, percent));
}

/** The thin meter and its percent, coloured only near the limit. */
function UsageLevelMeter({
  usedPercent,
  elapsedPercent,
  level,
  label,
  valueText,
}: {
  usedPercent: number;
  /** Where the window-elapsed triangle sits under the bar, if known. */
  elapsedPercent?: number;
  level: UsageLevel;
  label: string;
  /** What the meter means in words, for assistive technology. */
  valueText: string;
}): JSX.Element {
  return (
    <>
      <span className="relative w-14 shrink-0 @md/usage-group:w-33">
        <ProgressBar
          value={usedPercent}
          tone={METER_TONE[level]}
          size="compact"
          label={label}
          valueText={valueText}
          hideLabel
        />
        {elapsedPercent === undefined ? null : (
          <svg
            width="8"
            height="5"
            viewBox="0 0 8 5"
            className="absolute top-full mt-0.5 -translate-x-1/2 fill-fg-quaternary"
            style={{ left: `${elapsedPercent}%` }}
            // The meter's value text names the elapsed share with its window.
            aria-hidden="true"
            data-testid="usage-window-elapsed"
          >
            <path d="M4 0 L8 5 L0 5 Z" />
          </svg>
        )}
      </span>
      <span
        // The compact button's label size; only the meter fill carries the level. An
        // unused window's 0% steps back to tertiary.
        className={`w-9 shrink-0 text-right text-xs tabular-nums ${
          formatUsagePercent(usedPercent) === '0%'
            ? 'fg-tertiary'
            : 'fg-primary'
        }`}
        data-usage-level={level}
      >
        {formatUsagePercent(usedPercent)}
      </span>
    </>
  );
}

/**
 * The box a usage group's rows live in, the same secondary surface with a
 * hairline edge as a settings group. Every direct child is one row.
 */
export const USAGE_ROW_GROUP_CLASS =
  '@container/usage-group flex min-w-0 flex-col divide-y rounded-lg bg-secondary px-4 ring-[length:var(--border-hairline)] ring-inset ring-line-base *:min-h-13 *:py-3';

/** Rows without the box, for a disclosure inside another row. */
const USAGE_ROW_PLAIN_CLASS =
  '@container/usage-group flex min-w-0 flex-col *:min-h-11 *:py-2';

export function UsageRowList({
  children,
  plain = false,
  testId,
}: {
  children: ReactNode;
  /** Drop the box for rows nested inside another surface's row. */
  plain?: boolean;
  testId?: string;
}): JSX.Element {
  return (
    <div
      className={plain ? USAGE_ROW_PLAIN_CLASS : USAGE_ROW_GROUP_CLASS}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

/**
 * The `·` between a provider and its plan in a group heading, with about two spaces of air
 * on each side: one real space plus inset, never doubled space characters.
 */
function UsageSeparator(): JSX.Element {
  // The real spaces keep copied text and textContent `A · B`; the inset
  // doubles the gap each side.
  return (
    <>
      {' '}
      <span aria-hidden="true" className="px-1">
        ·
      </span>{' '}
    </>
  );
}

interface UsageRowContentProps {
  title: ReactNode;
  detail?: ReactNode;
  trailing?: ReactNode;
  /**
   * `action` for a button (an account action, View…): narrow, it drops to a
   * third line under the quiet line instead of sharing the name's line.
   */
  trailingKind?: 'meter' | 'action';
}

// Narrow (side panel, Portal): the name and the trailing meter or action
// share the first line and the quiet line runs the full width under them.
// Wide (page): the quiet line stays under the name and the trailing content
// is centred on both lines.
const USAGE_ROW_LAYOUT_CLASS =
  'grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3.5 text-s';

/** A row's name, quiet line and trailing content, as phrasing content. */
function UsageRowContent({
  title,
  detail,
  trailing,
  trailingKind = 'meter',
}: UsageRowContentProps): JSX.Element {
  return (
    <>
      <span className="col-start-1 row-start-1 block min-w-0 truncate fg-primary">
        {title}
      </span>
      {detail ? (
        <span className="col-span-2 row-start-2 mt-0.5 block text-xs text-pretty fg-secondary @md/usage-group:col-span-1">
          {detail}
        </span>
      ) : null}
      {trailing && trailingKind === 'action' ? (
        // 12px under the quiet line, and 4px more under it so the button sits
        // 16px from the card's bottom edge, the same as its left inset.
        <span className="col-start-1 row-start-3 flex justify-self-start pb-1 pt-3 @md/usage-group:col-start-2 @md/usage-group:row-span-2 @md/usage-group:row-start-1 @md/usage-group:py-0">
          {trailing}
        </span>
      ) : trailing ? (
        // One line tall on line 1 so a 28px button never pushes the quiet line
        // further from the name than a meter does (the settings row gap).
        <span className="col-start-2 row-start-1 flex h-lh shrink-0 items-center gap-2 @md/usage-group:row-span-2 @md/usage-group:h-auto">
          {trailing}
        </span>
      ) : null}
    </>
  );
}

/**
 * One row: a name with one quiet line under it, and an optional meter,
 * value or action on the trailing edge.
 */
export function UsageRow({
  testId,
  ...content
}: UsageRowContentProps & { testId?: string }): JSX.Element {
  return (
    <div className={USAGE_ROW_LAYOUT_CLASS} data-testid={testId}>
      <UsageRowContent {...content} />
    </div>
  );
}

/**
 * A window's status in words once it is red: `Limit reached` at 100%,
 * otherwise `Almost at the limit`. Null below the red threshold, for an
 * unlimited or unreported window, and once its reset time has passed.
 */
export function usageWindowStatus(
  window: UsageLimitCard,
  nowMs: number,
): 'Limit reached' | 'Almost at the limit' | null {
  const used = window.unlimited ? undefined : window.usedPercent;
  if (used === undefined || !Number.isFinite(used)) return null;
  if (isResetPassed(window.resetsAt, nowMs)) return null;
  if (usageLevel(used) !== 'danger') return null;
  return used >= 100 ? 'Limit reached' : 'Almost at the limit';
}

/** The meter's value in words: `98% used, Almost at the limit, resets …`. */
function windowMeterValueText(
  window: UsageLimitCard,
  usedPercent: number,
  nowMs: number,
): string {
  const reset = isResetPassed(window.resetsAt, nowMs)
    ? null
    : formatUsageResetPhrase(window.resetsAt, nowMs);
  return [
    `${formatUsagePercent(usedPercent)} used`,
    usageWindowStatus(window, nowMs),
    reset ? `resets ${reset}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(', ');
}

/** A window's reset, credit and state facts, in one line. */
function windowDetail(window: UsageLimitCard, nowMs: number): string {
  if (window.unlimited) return 'Unlimited';
  const parts: string[] = [];
  if (isResetPassed(window.resetsAt, nowMs)) {
    parts.push('Reset time has passed');
  } else {
    const status = usageWindowStatus(window, nowMs);
    // Only a reached limit says so in words; the meter's colour shows the
    // approach (its value text still names it for assistive technology).
    if (status === 'Limit reached') parts.push(status);
    const reset = formatUsageResetPhrase(window.resetsAt, nowMs);
    if (reset)
      parts.push(parts.length === 0 ? `Resets ${reset}` : `resets ${reset}`);
  }
  if (window.spend) {
    const used = formatSpendMoney(window.spend.used, window.spend.currency);
    const limit = formatSpendMoney(
      window.spend.limit ?? undefined,
      window.spend.currency,
    );
    if (window.spend.isEnabled === false) parts.push('Extra usage is off');
    if (used !== undefined) parts.push(`Monthly spend: ${used}`);
    else if (window.spend.isEnabled !== false)
      parts.push('Monthly spend unavailable');
    if (limit !== undefined) parts.push(`Monthly spending cap: ${limit}`);
    if (window.spend.limit === null) parts.push('No monthly cap');
    else if (
      window.spend.isEnabled !== false &&
      window.spend.limit === undefined &&
      limit === undefined
    )
      parts.push('Monthly cap unavailable');
  }
  const remaining = window.credits?.remainingUsd;
  if (remaining !== undefined) {
    parts.push(
      window.creditsAreCount
        ? formatCreditsLeft(remaining)
        : `$${remaining.toFixed(2)} left`,
    );
  }
  const spent = window.credits?.usedUsd;
  if (spent !== undefined) parts.push(`$${spent.toFixed(2)} spent`);
  if (
    window.usedPercent === undefined &&
    remaining === undefined &&
    spent === undefined &&
    window.spend === undefined
  ) {
    parts.unshift('Usage unavailable');
  }
  return parts.join(' · ');
}

/**
 * One limit window: its name, when it resets in words, a thin neutral meter
 * and the percent used. Only a window from 80% turns orange, from 95% red.
 * A window whose reset time has passed keeps its last value, uncoloured.
 */
export function UsageWindowRow({
  window,
  nowMs,
  testId,
}: {
  window: UsageLimitCard;
  nowMs: number;
  testId?: string;
}): JSX.Element {
  const detail = windowDetail(window, nowMs);
  const usedPercent = window.unlimited ? undefined : window.usedPercent;
  const stale = isResetPassed(window.resetsAt, nowMs);
  const elapsedPercent = usageWindowElapsedPercent(window, nowMs);
  return (
    <UsageRow
      title={window.title}
      detail={detail}
      testId={testId ?? `usage-window-${window.key}`}
      trailing={
        usedPercent === undefined ? null : (
          <UsageLevelMeter
            usedPercent={usedPercent}
            elapsedPercent={elapsedPercent}
            level={stale ? 'normal' : usageLevel(usedPercent)}
            label={`${window.title}: ${formatUsagePercent(usedPercent)} used`}
            valueText={[
              windowMeterValueText(window, usedPercent, nowMs),
              elapsedPercent === undefined
                ? null
                : `${Math.round(elapsedPercent)}% of the window elapsed`,
            ]
              .filter((part): part is string => part !== null)
              .join(', ')}
          />
        )
      }
    />
  );
}

/**
 * A group's heading: the provider name and its plan, in one quiet line.
 */
export function UsageGroupHeading({
  title,
  provider,
  plan,
  planTestId,
  headingId,
}: {
  title: string;
  /** Provider id whose brand mark leads the heading (`claude`, `codex`). */
  provider?: string;
  plan?: string | null;
  planTestId?: string;
  headingId?: string;
}): JSX.Element {
  // The mark is a flex item centred on the line box, not inline text, so it
  // never sits on the baseline below the words' centre.
  return (
    <div className="flex h-6 min-w-0 items-center px-0.5">
      <Heading level={2} variant="label" id={headingId} className="min-w-0">
        <span className="flex min-w-0 items-center gap-1.5">
          {provider ? (
            <ModelProviderIcon
              provider={provider}
              size="sm"
              aria-hidden="true"
              className="block shrink-0 fg-primary"
              data-testid="usage-group-provider-mark"
            />
          ) : null}
          <span className="min-w-0 truncate font-normal">
            <span className="font-medium fg-primary">{title}</span>
            {plan ? (
              <>
                <UsageSeparator />
                <span data-testid={planTestId}>{plan}</span>
              </>
            ) : null}
          </span>
        </span>
      </Heading>
    </div>
  );
}

/** A provider's section: its heading, then whatever rows the host supplies. */
export function UsageGroup({
  title,
  provider,
  plan,
  planTestId,
  testId,
  children,
  childrenGap,
}: {
  title: string;
  provider?: string;
  plan?: string | null;
  planTestId?: string;
  testId?: string;
  children: ReactNode;
  /** Own the gaps between host rows when those rows have no outer margins. */
  childrenGap?: SpaceRole;
}): JSX.Element {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-testid={testId}
      className="min-w-0"
    >
      <Stack gap="item">
        <UsageGroupHeading
          title={title}
          provider={provider}
          plan={plan}
          planTestId={planTestId}
          headingId={headingId}
        />
        {childrenGap === undefined ? (
          <div>{children}</div>
        ) : (
          <Stack gap={childrenGap}>{children}</Stack>
        )}
      </Stack>
    </section>
  );
}

/**
 * One provider: a row per limit window, then the host's rows (accounts go
 * last), then anything that sits under the box, such as an error. Every
 * window always shows.
 */
export function UsageProviderGroup({
  title,
  provider,
  plan,
  planTestId,
  windows,
  nowMs,
  rows,
  footer,
  separateFooter = false,
  testId,
}: {
  title: string;
  /** Provider id whose brand mark leads the heading. */
  provider?: string;
  plan?: string | null;
  planTestId?: string;
  windows: readonly UsageLimitCard[];
  nowMs: number;
  /** Rows after the windows, such as the account row. */
  rows?: ReactNode;
  /** Content under the box: errors, notes, retained snapshots. */
  footer?: ReactNode;
  /** Own the existing 6px boundary before a margin-free account snapshot footer. */
  separateFooter?: boolean;
  testId?: string;
}): JSX.Element {
  const headingId = useId();
  const body = (
    <div className={USAGE_ROW_GROUP_CLASS}>
      {windows.map((window) => (
        <UsageWindowRow key={window.key} window={window} nowMs={nowMs} />
      ))}
      {rows}
    </div>
  );
  const footerContent = (
    <NoticeShapeProvider shape="settings">{footer}</NoticeShapeProvider>
  );
  return (
    <section
      aria-labelledby={headingId}
      data-testid={testId}
      className="min-w-0"
    >
      <Stack gap="item">
        <UsageGroupHeading
          title={title}
          provider={provider}
          plan={plan}
          planTestId={planTestId}
          headingId={headingId}
        />
        {/* Notices under the box take its corners. */}
        {separateFooter ? (
          <div className="flex flex-col gap-1.5">
            {body}
            <div className="empty:hidden">{footerContent}</div>
          </div>
        ) : (
          <div>
            {body}
            {footerContent}
          </div>
        )}
      </Stack>
    </section>
  );
}

/** The one refresh control a usage surface has, a quiet round icon button. */
export function UsageRefreshButton({
  refreshing,
  disabled = false,
  onRefresh,
  label = 'Refresh usage',
  testId = 'usage-refresh',
}: {
  refreshing: boolean;
  disabled?: boolean;
  onRefresh: () => void;
  label?: string;
  testId?: string;
}): JSX.Element {
  return (
    <Tooltip label={label}>
      <Button
        variant="ghost"
        size="compact"
        iconOnly
        aria-label={label}
        aria-busy={refreshing || undefined}
        // aria-disabled, not disabled, while refreshing: the focused button
        // stays in the Tab order instead of dropping focus to the page.
        aria-disabled={refreshing || undefined}
        busyAppearance="preserved"
        disabled={disabled}
        onClick={onRefresh}
        data-testid={testId}
      >
        <RefreshSpinner spinning={refreshing} size="sm" />
      </Button>
    </Tooltip>
  );
}

/**
 * When the usage was last read, with the refresh control beside it: the
 * status line a usage panel shows above its groups.
 */
export function UsageUpdatedLine({
  updatedAt,
  nowMs,
  refreshing,
  disabled,
  onRefresh,
}: {
  updatedAt: string | number | null | undefined;
  nowMs: number;
  refreshing: boolean;
  disabled?: boolean;
  onRefresh: () => void;
}): JSX.Element {
  const updated = formatUsageUpdatedPhrase(updatedAt, nowMs);
  return (
    <div
      className="flex min-w-0 items-center justify-between gap-2 text-xs fg-secondary"
      data-testid="usage-updated-line"
    >
      <span className="truncate">
        {refreshing ? 'Updating…' : (updated ?? 'Not updated yet')}
      </span>
      <UsageRefreshButton
        refreshing={refreshing}
        disabled={disabled}
        onRefresh={onRefresh}
      />
    </div>
  );
}
