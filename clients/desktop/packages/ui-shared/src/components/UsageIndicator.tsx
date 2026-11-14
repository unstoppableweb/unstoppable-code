import {
  parseOpenCodeReportedUsage,
  type OpenCodeReportedUsage,
  type ReportedTurnUsage,
} from '@canopy/protocol/portal';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  lazy,
  Suspense,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import type { ModelLibraryAccess } from '@canopy/protocol/models';
import { getDocument } from '../panels/window-registry';
import { AI_CREDITS_LABEL } from './aiCreditsLabel';
import { formatCost, formatUsageResetWhen } from '../lib/format-usage';
import { ProgressRing, type ProgressTone } from './Progress';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { InlineTextSkeleton } from './InlineTextSkeleton';
import { Button } from './Button';

import { DisclosureChevron } from './Disclosure';
import { UsageMeter, formatUsagePercent } from './usage-indicator-meter';
export { USAGE_TOUCH_FLOOR_CLASS } from './usage-indicator-meter';
import {
  UsageTextAction,
  USAGE_DISCLOSURE_ROW_CLASS,
  USAGE_DISCLOSURE_INK_CLASS,
} from './UsageIndicatorActions';
export {
  UsageActionRow,
  UsageExpandableRow,
  UsageSectionHeader,
  UsageTextAction,
  USAGE_DISCLOSURE_ROW_CLASS,
  USAGE_DISCLOSURE_INK_CLASS,
} from './UsageIndicatorActions';

const UsagePopover = lazy(() => import('./UsageIndicatorPopover'));

/**
 * The usage figures the composer meter renders. Cumulative counters are the
 * chat's running totals; `contextTokens` / `contextWindow` describe the
 * current context fill. Cost, duration, and cache-write are optional because
 * not every runtime reports them (Codex, or a cloud harness whose cost is
 * unavailable); an absent value hides its row rather than showing a zero.
 */
export interface UsageIndicatorResponse {
  title?: string;
  context?: { usedTokens: number; maxTokens: number };
  message: string;
  note: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    estimatedCostUsd?: number;
  };
}

/** One reported-usage presentation shared by every OpenCode chat host. */
export function createOpenCodeUsageResponse(
  value: OpenCodeReportedUsage | null | undefined,
): UsageIndicatorResponse {
  const report = parseOpenCodeReportedUsage(value);
  return {
    title: 'Turn usage',
    message: report?.turn
      ? 'Latest reported turn. Input excludes cached tokens.'
      : 'OpenCode has not reported token usage for this turn.',
    note: 'Account limits and billed charges are unavailable.',
    usage: report?.turn,
    context: report?.context,
  };
}

const CREDIT_COUNT_FORMAT = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 2,
});
const SMALL_CREDIT_COUNT_FORMAT = new Intl.NumberFormat('en-US', {
  maximumSignificantDigits: 2,
});

/** A balance counted in credits, not dollars: `62,500`, `12.5`. */
export function formatCreditCount(credits: number): string {
  return credits > 0 && credits < 0.005
    ? SMALL_CREDIT_COUNT_FORMAT.format(credits)
    : CREDIT_COUNT_FORMAT.format(credits);
}

/** A credit balance as a count: `62,500 credits left`, `1 credit left`. */
export function formatCreditsLeft(credits: number): string {
  return `${formatCreditCount(credits)} ${
    credits === 1 ? 'credit' : 'credits'
  } left`;
}

/**
 * A whole AI Credits wallet balance as the composer shows it, as a plain
 * fact: `12.5 AI Credits` or `0 AI Credits`. The product term stays
 * plural like every other AI Credits label.
 */
export function formatAiCreditsCount(credits: number): string {
  return `${formatCreditCount(credits)} ${AI_CREDITS_LABEL}`;
}

/**
 * The popover's AI Credits section: one row, the label once with the
 * figure and Manage across from it, as the Context and Cost rows read.
 */
function CreditBalanceRow({
  balance,
}: {
  balance: UsageIndicatorCreditBalance;
}): JSX.Element {
  const label = AI_CREDITS_LABEL;
  const pending = balance.credits === null;
  return (
    <section
      data-testid="usage-indicator-account"
      aria-label={`${label} balance`}
      aria-busy={pending ? true : undefined}
      className="flex items-baseline justify-between gap-3 text-xs"
    >
      <span className="fg-primary">{label}</span>
      <span className="flex shrink-0 items-baseline gap-3">
        <span className="fg-secondary">
          <CreditBalanceFigure
            testId="usage-indicator-account-credit-balance"
            text={
              balance.credits === null
                ? null
                : formatCreditCount(balance.credits)
            }
          />
        </span>
        {balance.onManage && (
          <UsageTextAction
            label="Manage"
            onClick={balance.onManage}
            ariaLabel="Manage AI Credits"
          />
        )}
      </span>
    </section>
  );
}

/**
 * The known balance of the wallet paying for this chat. Hosts pass it only
 * for a credit-routed chat whose funding owner and balance they could verify;
 * every other chat omits it rather than showing a guess.
 */
export interface UsageIndicatorCreditBalance {
  /**
   * The whole wallet balance, not what is left of today's grant. `null` holds
   * the balance's place while a re-read replaces a figure the host withdrew
   * (CAN-5026); the trigger and popover show a skeleton, never the old figure.
   */
  readonly credits: number | null;
  /** Opens the host's AI Credits management view. */
  readonly onManage?: () => void;
  /**
   * The paying wallet's model-library access. Ignored: the balance always
   * reads `AI Credits` (CAN-4769). Kept until hosts stop passing it.
   */
  readonly libraryAccess?: ModelLibraryAccess;
}

/**
 * A finite, non-negative balance, or an explicit pending one; anything else
 * is not shown.
 */
function isShowableCreditBalance(
  balance: UsageIndicatorCreditBalance | undefined,
): balance is UsageIndicatorCreditBalance {
  if (balance === undefined) return false;
  const { credits } = balance;
  return credits === null || (Number.isFinite(credits) && credits >= 0);
}

/**
 * The trigger's balance slot. A pending balance keeps the width the last
 * figure occupied, so the capsule does not shrink and regrow around the
 * re-read; with no figure measured yet it falls back to a typical width.
 */
function CreditBalanceFigure({
  text,
  testId,
}: {
  text: string | null;
  testId: string;
}): JSX.Element {
  const figureRef = useRef<HTMLSpanElement>(null);
  const [figureWidth, setFigureWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (text === null || figureRef.current === null) return;
    const width = figureRef.current.getBoundingClientRect().width;
    if (width > 0) setFigureWidth(width);
  }, [text]);
  if (text === null) {
    return (
      <span
        data-testid={testId}
        data-pending="true"
        className="flex min-w-0 items-center"
      >
        <InlineTextSkeleton
          className={figureWidth === null ? 'w-20 max-w-full' : 'max-w-full'}
          style={figureWidth === null ? undefined : { width: figureWidth }}
        />
      </span>
    );
  }
  return (
    <span
      ref={figureRef}
      data-testid={testId}
      className="min-w-0 truncate whitespace-nowrap tabular-nums"
    >
      {text}
    </span>
  );
}

export interface UsageIndicatorAccountSummaryProps {
  providerLabel: string;
  /** The signed-in account, usually its email; shown under the plan. */
  account?: string;
  /** The subscription's full name (`Claude Max 20x`, `ChatGPT Pro`). */
  plan?: string;
  status?: string;
  limits: Array<{
    id: string;
    label: string;
    usedPercent?: number;
    unlimited?: boolean;
    resetsAt?: string | number;
    usedUsd?: number;
    remainingUsd?: number;
    totalUsd?: number;
    /** A balance counted in the provider's credits, not dollars (Codex). */
    remainingCredits?: number;
  }>;
  /**
   * Fetches the account's usage again. Offered only when the last read
   * failed; the host refreshes on its own as the popover opens.
   */
  onRetry?: () => void;
  /**
   * Account settings the popover cannot show, as a labelled action. Omit it
   * when the host's "See detailed breakdown" already leads to the same place.
   */
  onManage?: () => void;
  /**
   * The account's one fact for this chat, right of the title: its share
   * (`65% of turns`), or when a resting account is back. With it the
   * header takes two lines, the account as the title over the plan, for a
   * popover that lists several accounts; `onManage` is not shown there, so
   * the host offers one Manage row for the list.
   */
  detail?: string;
  /**
   * With `detail`: the provider's mark before the plan, at 12px to match
   * the plan's 11px line; drawn in the quiet ink.
   */
  icon?: ReactNode;
  /**
   * With `detail`: folds the limits into a meter beside the plan. The whole
   * card is the toggle, like the popover's Context and Cost rows. Absent,
   * every limit shows.
   */
  disclosure?: UsageIndicatorAccountDisclosure;
}

export interface UsageIndicatorAccountDisclosure {
  readonly expanded: boolean;
  readonly onToggle: () => void;
  /**
   * The limit shown while folded. It leads when open too, so opening only
   * adds rows below it; the first limit when absent or not in `limits`.
   */
  readonly leadLimitId?: string;
}

type UsageIndicatorAccountLimit =
  UsageIndicatorAccountSummaryProps['limits'][number];

/** The lead limit first, then the rest in their order. */
function orderAccountLimits(
  limits: readonly UsageIndicatorAccountLimit[],
  leadLimitId: string | undefined,
): readonly UsageIndicatorAccountLimit[] {
  const lead = limits.find((limit) => limit.id === leadLimitId) ?? limits[0];
  if (lead === undefined) return limits;
  return [lead, ...limits.filter((limit) => limit !== lead)];
}

/** One limit: its name, reset time and percent over its meter. */
function AccountLimitRow({
  limit,
}: {
  limit: UsageIndicatorAccountLimit;
}): JSX.Element {
  const resetWhen = formatUsageResetWhen(limit.resetsAt);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="min-w-0 truncate fg-primary">{limit.label}</span>
        <span className="flex shrink-0 items-baseline gap-2 tabular-nums">
          {resetWhen && (
            // Shown as just the time ("In 2 hr 45 min", "Sun 4:38 AM")
            // so the popover fits 292px; "Resets" stays for screen
            // readers, which read the whole sentence.
            <span className="fg-secondary">
              <span className="sr-only">Resets </span>
              <span className="inline-block first-letter:uppercase">
                {resetWhen}
              </span>
            </span>
          )}
          {(limit.unlimited || limit.usedPercent !== undefined) && (
            <span className="fg-secondary">
              {limit.unlimited
                ? 'Unlimited'
                : limit.usedPercent !== undefined
                  ? formatUsagePercent(limit.usedPercent)
                  : null}
            </span>
          )}
        </span>
      </div>
      {!limit.unlimited && limit.usedPercent !== undefined && (
        <UsageMeter
          percentage={limit.usedPercent}
          label={`${limit.label} used`}
        />
      )}
      {limit.remainingCredits !== undefined && (
        <div className="text-xs tabular-nums fg-secondary">
          {formatCreditsLeft(limit.remainingCredits)}
        </div>
      )}
      {(limit.usedUsd !== undefined || limit.remainingUsd !== undefined) && (
        <div className="text-xs tabular-nums fg-secondary">
          {limit.usedUsd !== undefined && `Spent ${formatCost(limit.usedUsd)}`}
          {limit.usedUsd !== undefined &&
            limit.remainingUsd !== undefined &&
            ' · '}
          {limit.remainingUsd !== undefined &&
            `${formatCost(limit.remainingUsd)}${
              limit.totalUsd !== undefined
                ? ` of ${formatCost(limit.totalUsd)}`
                : ''
            } left`}
        </div>
      )}
    </div>
  );
}

/**
 * A listed account's two lines: the account as the title with, folded, its
 * lead meter and the chevron at the right; then the provider mark and plan
 * with the account's one fact at the right, in the quieter ink.
 */
function AccountCardHeader({
  icon,
  plan,
  account,
  detail,
  quiet,
  mini,
  open,
}: {
  icon: ReactNode;
  plan: string;
  account: string | undefined;
  detail: string;
  /** The ink of the quieter text: brightening with the card's hover. */
  quiet: string;
  mini?: ReactNode;
  /** Whether the card is open; absent, the card does not fold. */
  open?: boolean;
}): JSX.Element {
  return (
    <>
      <span className="flex items-center gap-3">
        <span
          data-testid="usage-indicator-account-label"
          className="min-w-0 flex-1 truncate fg-primary"
        >
          {account ? (
            // Session replay blocks the account; its tooltip sits on the
            // blocked element, which records no attributes.
            <span className={REPLAY_BLOCK_CLASS} title={account}>
              {account}
            </span>
          ) : (
            plan
          )}
        </span>
        {(mini || open !== undefined) && (
          // The lead meter and the chevron, as the Context row's value and
          // chevron; 8px apart, as the chevron's glyph sits inset in its box.
          <span className={`flex shrink-0 items-center gap-2 ${quiet}`}>
            {mini}
            {open !== undefined && (
              <DisclosureChevron direction={open ? 'up' : 'down'} animated />
            )}
          </span>
        )}
      </span>
      {/* One step down the type scale from the title, in the quieter ink. */}
      <span className="flex items-center justify-between gap-3 text-2xs">
        <span className="flex min-w-0 items-center gap-1.5">
          {icon && (
            <span aria-hidden="true" className="flex shrink-0 fg-tertiary">
              {icon}
            </span>
          )}
          <span
            data-testid="usage-indicator-plan"
            className={`min-w-0 truncate ${quiet}`}
          >
            {account ? plan : null}
          </span>
        </span>
        <span
          data-testid="usage-indicator-account-detail"
          className={`shrink-0 whitespace-nowrap ${quiet}`}
        >
          {detail}
        </span>
      </span>
    </>
  );
}

/**
 * Plan usage limits for the chat's provider account, kept separate from the
 * current chat's context. One meter per limit, each with its own reset time,
 * so the rows scan as a column of bars.
 */
export function UsageIndicatorAccountSummary({
  providerLabel,
  account,
  plan,
  status,
  limits,
  onRetry,
  onManage,
  detail,
  disclosure,
  icon,
}: UsageIndicatorAccountSummaryProps): JSX.Element {
  const card = detail !== undefined;
  const folds = card ? disclosure : undefined;
  const ordered = folds
    ? orderAccountLimits(limits, folds.leadLimitId)
    : limits;
  const lead = ordered[0];
  // Folded, the lead limit's meter sits beside the plan; a limit with no
  // meter (unlimited, credits) stays a row instead. Opening shows every
  // limit at once, as the Context and Cost rows open.
  const meterFolds =
    folds !== undefined &&
    lead !== undefined &&
    !lead.unlimited &&
    lead.usedPercent !== undefined;
  const shownLimits = folds
    ? folds.expanded
      ? ordered
      : ordered.slice(0, meterFolds ? 0 : 1)
    : limits;
  const mini =
    meterFolds && lead?.usedPercent !== undefined ? (
      // The lead meter at the header's size; hidden (and out of the
      // accessibility tree) while the full rows show, so the header keeps
      // its layout.
      <div
        data-testid="usage-indicator-account-mini"
        className={`w-20 shrink-0 ${folds.expanded ? 'invisible' : ''}`}
      >
        <UsageMeter
          percentage={lead.usedPercent}
          label={`${lead.label} used`}
        />
      </div>
    ) : undefined;
  const statusLine = status && (
    <p role="status" className="text-xs fg-secondary">
      {status}{' '}
      {onRetry && (
        <Button
          variant="link"
          onClick={onRetry}
          data-testid="usage-indicator-retry"
        >
          Try again
        </Button>
      )}
    </p>
  );
  const limitRows = shownLimits.map((limit) => (
    <AccountLimitRow key={limit.id} limit={limit} />
  ));

  if (card) {
    const quiet = folds ? USAGE_DISCLOSURE_INK_CLASS : 'fg-secondary';
    const header = (
      <AccountCardHeader
        icon={icon}
        plan={plan ?? providerLabel}
        account={account}
        detail={detail}
        quiet={quiet}
        mini={mini}
        {...(folds ? { open: folds.expanded } : {})}
      />
    );
    return (
      // An inset card on the depth surface: 4px in from the popover's edge,
      // so its 8px corners nest in the popover's 12px ones, and 8px inside,
      // so its text lines up with the popover's other rows. Top and bottom
      // are 8px and 12px: the title's 18px line puts 4px of leading above
      // its letters, so the drawn text sits 12px from the top as it does
      // from the bottom.
      <section
        data-testid="usage-indicator-account"
        aria-label={`${providerLabel} usage limits`}
        className="relative -mx-2 flex flex-col gap-2 rounded-md bg-depth px-2 pb-3 pt-2"
      >
        {folds ? (
          <button
            type="button"
            onClick={folds.onToggle}
            aria-expanded={folds.expanded}
            data-testid="usage-indicator-account-toggle"
            // As the Context row: the whole card takes the click (its
            // `after:` overlay), and its quieter ink and chevron brighten.
            className={`${USAGE_DISCLOSURE_ROW_CLASS} flex-col gap-1.5 after:absolute after:inset-0 after:rounded-md after:content-['']`}
          >
            {header}
          </button>
        ) : (
          <div className="flex flex-col gap-1.5 text-xs">{header}</div>
        )}
        {statusLine}
        {limitRows}
      </section>
    );
  }

  return (
    <section
      data-testid="usage-indicator-account"
      aria-label={`${providerLabel} usage limits`}
      className="flex flex-col gap-3"
    >
      {/* Which subscription the limits below belong to, and whose: the
          plan, then the account in brackets after it, with Manage across
          from them like each limit's reset time. A long account truncates. */}
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="flex min-w-0 items-baseline gap-1">
          <span
            data-testid="usage-indicator-plan"
            className="shrink-0 fg-primary"
          >
            {plan ?? providerLabel}
          </span>
          {account && (
            // Session replay blocks the account; its tooltip sits on the
            // blocked element, which records no attributes.
            <span
              data-testid="usage-indicator-account-label"
              className="min-w-0 truncate fg-secondary"
            >
              (
              <span className={REPLAY_BLOCK_CLASS} title={account}>
                {account}
              </span>
              )
            </span>
          )}
        </span>
        {onManage && (
          <UsageTextAction
            label="Manage"
            onClick={onManage}
            ariaLabel={`Manage ${providerLabel}`}
          />
        )}
      </div>
      {statusLine}
      {limitRows}
    </section>
  );
}

export interface UsageIndicatorUsage {
  /** A provider's latest turn snapshot; null explicitly clears older counts. */
  reportedTurnUsage?: ReportedTurnUsage | null;
  /** Current context window fill. */
  contextTokens: number;
  /** Model context window; 0 when unknown (hides the meter). */
  contextWindow: number;
  /** Cumulative session cost in USD. */
  totalCostUsd?: number;
  /** Cumulative input tokens. */
  inputTokens: number;
  /** Cumulative output tokens. */
  outputTokens: number;
  /** Cumulative cache read input tokens. */
  cacheReadInputTokens: number;
  /** Cumulative cache creation (write) input tokens. */
  cacheCreationInputTokens?: number;
  /** Total duration in milliseconds. */
  durationMs?: number;
  /** Number of turns completed. */
  numTurns: number;
  /** Model name string from the last assistant message. */
  model: string;
}

/**
 * Fallback when neither a usage nor a model with a configured context window
 * is known. The popover still opens so the meter never reads as broken; the
 * Context row is simply omitted (a window of 0 is not a window).
 */
const UNKNOWN_USAGE: UsageIndicatorUsage = {
  contextTokens: 0,
  contextWindow: 0,
  totalCostUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  durationMs: 0,
  numTurns: 0,
  model: '',
};

// ---------------------------------------------------------------------------
// Color thresholds
// ---------------------------------------------------------------------------

/**
 * Realm-neutral node check: the popover may live in an auxiliary window whose
 * nodes are not instances of this realm's `Node`, so `instanceof` would treat
 * a click inside the popover as an outside click.
 */
function isDomNode(value: unknown): value is Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    'nodeType' in value &&
    typeof value.nodeType === 'number'
  );
}

/** The ring warns as the context nears its limit, like the meter bar. */
export function getUsageRingTone(percentage: number): ProgressTone {
  if (percentage >= 90) return 'destructive';
  if (percentage >= 70) return 'warning';
  return 'neutral';
}

/**
 * What fills the context window, by category (the provider's /context
 * breakdown). Mirrors the host's contract; the component only draws it.
 */
export interface UsageIndicatorContextBreakdown {
  categories: Array<{
    name: string;
    tokens: number;
    /** `deferred` rows sit outside the window and take no share of it. */
    kind: 'used' | 'free' | 'buffer' | 'deferred';
  }>;
  /** The window the categories are measured against. */
  maxTokens: number;
}

// ---------------------------------------------------------------------------
// UsageIndicator — main export
// ---------------------------------------------------------------------------

export interface UsageIndicatorProps {
  /** Mounted only while the popup is open; hosts own account subscriptions. */
  accountUsage?: ReactNode;
  responseUsage?: UsageIndicatorResponse;
  usage: UsageIndicatorUsage | undefined;
  isCodex: boolean;
  modelLabel?: string;
  /** Opens the host's full usage view from the popover's footer link. */
  onSeeDetails?: () => void;
  /**
   * What fills the context window, by category. With it the meter splits
   * into its categories and the expanded view lists them; without it the
   * expanded view shows the session's cost and token counts.
   */
  contextBreakdown?: UsageIndicatorContextBreakdown;
  /**
   * The chat's cost row, previewed under Context. A host with a cost read
   * path passes it (`UsageCostPreviewRow` from `components/cost`); it replaces
   * the session Cost figure. The popover imports no cost code itself.
   */
  readonly costPreview?: ReactNode;
  /**
   * The host bills every turn to AI Credits with no provider subscription, so
   * no USD figure is shown: the session Cost row, the host's cost preview row
   * and the per-response Estimated cost row stay out. Tokens, duration,
   * turns, context and the credit balance are unaffected.
   */
  readonly hideCost?: boolean;
  /** Called as the popover opens and closes (hosts fetch fresh data on open). */
  onOpenChange?: (open: boolean) => void;
  /**
   * The 32px round trigger of the composer's capsule controls (model,
   * effort), so the meter's hover shape matches theirs.
   */
  capsule?: boolean;
  /**
   * Host-resolved usage for a chat whose session has not produced a turn yet
   * (every counter at zero, sized to the model's configured context window),
   * so the meter stays alive instead of rendering a dead ring. Ignored once
   * `usage` is known.
   */
  seedUsage?: UsageIndicatorUsage;
  /** Lines the popover's right edge up with this element (the composer box). */
  alignRef?: RefObject<HTMLElement | null>;
  /**
   * The AI Credits balance paying for this chat. The trigger shows it as
   * `{N} AI Credits` beside the context ring, and the popover's account
   * section shows the same figure, in place of `accountUsage`: a credit-routed chat is not billed to
   * a subscription. `credits: null` shows a pending skeleton in both places;
   * an invalid figure is ignored.
   */
  creditBalance?: UsageIndicatorCreditBalance;
  /**
   * The 7-day plan limit binding this chat's model, account and harness.
   * With it the ring shows that limit, and hover shows its % beside the
   * ring; the context fill stays in the popover. Omit it for a chat with no
   * 7-day limit, or while its share is not known: the ring then shows the
   * context fill.
   */
  weeklyLimit?: UsageIndicatorWeeklyLimit;
  /**
   * A host control for the chat's context window, shown under Context
   * (`CodexContextWindowControl` for Codex chats). Mounted only while the
   * popover is open.
   */
  contextWindowControl?: ReactNode;
  /**
   * Requests with more input than this are billed at long-context rates; the
   * context meter marks it when the window is larger.
   */
  longContextThresholdTokens?: number;
}

export interface UsageIndicatorWeeklyLimit {
  /** Share of the 7-day limit used, 0–100; clamped. */
  readonly usedPercent: number;
}

// Hover, keyboard focus or an open popover shows the weekly % beside the
// ring. Nothing resizes: the trigger keeps its 32px box, the hover fill is
// drawn at its open width and revealed with clip-path, and the % fades and
// slides in, so the row never relayouts. `ComposerAccessUsage` slides the
// access control before the meter aside with room for the widest label.
// Tailwind needs each class written out, so the open states are spelled per
// element; `data-open` holds a still frame open for captures and tests.
//
// Motion (Emil Kowalski's rules): one soft ease-out, `ease-drawer`,
// on every part; 180 ms in and a quicker 120 ms out; CSS
// transitions, so a pointer that leaves mid-way reverses from where it is.
// Hover counts only for a fine pointer, so a tap cannot leave it open.
// Reduced motion keeps the fades and drops the movement.

/** Leaving: 120 ms, with no delayed tail on quick pointer exits. */
const WEEKLY_EXIT = 'duration-120 ease-drawer motion-reduce:transition-none';

/** Arriving: 180 ms, the duration taken from the open state. */
const WEEKLY_ENTER =
  'pointer-fine:group-hover/weekly:duration-180 group-focus-visible/weekly:duration-180 group-aria-expanded/weekly:duration-180 group-data-[open=true]/weekly:duration-180';

/**
 * The hover fill: the composer controls' 32px round hover, grown leftward
 * into a pill around the %. Right to left it holds its usual 8px edge, the
 * ring, a 10px gap, the label's intrinsic width and a 14px leading edge.
 * The transparent ring slot keeps the real ring stationary during reveal.
 */
const WEEKLY_HOVER_FILL = `pointer-events-none absolute -right-2 -top-2 flex h-8 w-max items-center gap-2.5 bg-subtle pl-3.5 pr-2 opacity-0 usage-weekly-fill-closed transition-[clip-path,opacity] ${WEEKLY_EXIT} ${WEEKLY_ENTER} pointer-fine:group-hover/weekly:opacity-100 group-focus-visible/weekly:opacity-100 group-aria-expanded/weekly:opacity-100 group-data-[open=true]/weekly:opacity-100 pointer-fine:group-hover/weekly:usage-weekly-fill-open group-focus-visible/weekly:usage-weekly-fill-open group-aria-expanded/weekly:usage-weekly-fill-open group-data-[open=true]/weekly:usage-weekly-fill-open`;

/**
 * The %, one step below the row's labels, 10px left of the ring. It fades in
 * with the fill, without a stagger that can trail rapid pointer reversals.
 */
const WEEKLY_PERCENT = `pointer-events-none flex h-4 items-center whitespace-nowrap text-2xs fg-primary opacity-0 translate-x-1 motion-reduce:translate-x-0 transition-[opacity,translate] motion-reduce:transition-opacity ${WEEKLY_EXIT} ${WEEKLY_ENTER} pointer-fine:group-hover/weekly:opacity-100 group-focus-visible/weekly:opacity-100 group-aria-expanded/weekly:opacity-100 group-data-[open=true]/weekly:opacity-100 pointer-fine:group-hover/weekly:translate-x-0 group-focus-visible/weekly:translate-x-0 group-aria-expanded/weekly:translate-x-0 group-data-[open=true]/weekly:translate-x-0`;

/** The ring with the weekly % that appears beside it. */
function WeeklyRing({
  value,
  tone,
  text,
}: {
  value: number;
  tone: ProgressTone;
  text: string;
}): JSX.Element {
  return (
    <span className="relative block h-4 w-4" aria-hidden>
      <span className={WEEKLY_HOVER_FILL} data-part="weekly-fill">
        <span className={WEEKLY_PERCENT} data-part="weekly-percent">
          {text}
        </span>
        <span className="h-4 w-4 shrink-0" />
      </span>
      <ProgressRing value={value} tone={tone} className="relative" />
    </span>
  );
}

export function UsageIndicator({
  usage: reportedUsage,
  isCodex,
  seedUsage,
  modelLabel,
  responseUsage: suppliedResponseUsage,
  accountUsage,
  onSeeDetails,
  contextBreakdown,
  costPreview,
  hideCost = false,
  onOpenChange,
  capsule = false,
  alignRef,
  creditBalance,
  weeklyLimit,
  contextWindowControl,
  longContextThresholdTokens,
}: UsageIndicatorProps): JSX.Element {
  // A tab with no usage yet still gets a usable meter: the host's seed when
  // one is known, otherwise an all-zero placeholder so the popover can at
  // least say why it is empty (CAN-2799). The seed is synthetic, so the
  // popover shows its zero but never its window as the runtime's figure —
  // Codex only reports context through `token_usage_updated`.
  const usage = reportedUsage ?? seedUsage ?? UNKNOWN_USAGE;
  const responseUsage =
    suppliedResponseUsage ??
    (usage.reportedTurnUsage !== undefined
      ? {
          title: 'Turn usage',
          message: usage.reportedTurnUsage
            ? 'Latest reported turn. Input excludes reported cached tokens.'
            : 'The provider has not reported token usage for this turn.',
          note: usage.reportedTurnUsage?.reasoningIncludedInOutput
            ? 'Output includes reasoning. Cost and context usage are unavailable.'
            : 'Cost and context usage are unavailable.',
          usage: usage.reportedTurnUsage ?? undefined,
        }
      : undefined);
  const [open, setOpen] = useState(false);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  useEffect(() => {
    onOpenChangeRef.current?.(open);
  }, [open]);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Opens on click only: hovering past the meter on the way to the send
  // button should not throw a popover over the composer.
  const handleClick = useCallback((): void => {
    setOpen((previous) => !previous);
  }, []);

  const closePopover = useCallback((): void => setOpen(false), []);

  // Escape closes the popover from anywhere and hands focus back to the ring.
  useEffect(() => {
    if (!open) return undefined;
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    const doc = getDocument(containerRef.current);
    doc.addEventListener('keydown', handler, true);
    return (): void => doc.removeEventListener('keydown', handler, true);
  }, [open]);

  // Close on an outside click.
  useEffect(() => {
    if (!open) return undefined;
    const handler = (e: MouseEvent): void => {
      const target = isDomNode(e.target) ? e.target : null;
      const insideTrigger =
        target !== null &&
        containerRef.current !== null &&
        containerRef.current.contains(target);
      const insidePopover =
        target !== null &&
        popoverRef.current !== null &&
        popoverRef.current.contains(target);
      if (!insideTrigger && !insidePopover) {
        setOpen(false);
      }
    };
    const doc = getDocument(containerRef.current);
    doc.addEventListener('mousedown', handler);
    return (): void => doc.removeEventListener('mousedown', handler);
  }, [open]);

  // Nothing counted yet and no split to show: the popover draws the row at
  // zero instead (see `showEmptyContext`).
  const showContextWindow =
    !responseUsage &&
    usage.contextWindow > 0 &&
    (usage.contextTokens > 0 || contextBreakdown !== undefined);
  const percentage = showContextWindow
    ? Math.min((usage.contextTokens / usage.contextWindow) * 100, 100)
    : 0;

  // An invalid share is ignored, like an invalid credit balance.
  const weeklyPercent =
    weeklyLimit !== undefined && Number.isFinite(weeklyLimit.usedPercent)
      ? Math.min(Math.max(weeklyLimit.usedPercent, 0), 100)
      : undefined;
  const ringPercent = weeklyPercent ?? percentage;
  const ringTone = getUsageRingTone(ringPercent);

  // One figure for the trigger and the popover, so they never disagree.
  const balance = isShowableCreditBalance(creditBalance)
    ? creditBalance
    : undefined;
  const balancePending = balance?.credits === null;
  const balanceText =
    balance && balance.credits !== null
      ? formatAiCreditsCount(balance.credits)
      : null;
  const accountSection = balance ? (
    <CreditBalanceRow balance={balance} />
  ) : (
    accountUsage
  );
  const wideTrigger = responseUsage !== undefined || balance !== undefined;
  // The % shows beside the ring only where the ring stands alone.
  const weeklyRing = capsule && !wideTrigger && weeklyPercent !== undefined;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        ref={triggerRef}
        onClick={handleClick}
        className={`focus-ring flex items-center text-2xs fg-secondary transition-colors hover:fg-primary ${
          // The weekly fill is the hover state; the round hover fill would
          // sit under it.
          weeklyRing
            ? 'group/weekly h-8 w-8 justify-center rounded-full pointer-coarse:min-h-11 pointer-coarse:min-w-11'
            : capsule
              ? wideTrigger
                ? 'h-8 min-w-8 max-w-full justify-center gap-1 rounded-full px-2.5 pointer-coarse:min-h-11 pointer-coarse:min-w-11'
                : 'h-8 w-8 justify-center rounded-full pointer-coarse:min-h-11 pointer-coarse:min-w-11'
              : 'gap-1 rounded-md px-1.5 py-0.5'
        }${weeklyRing ? '' : ' hover:bg-subtle'}`}
        data-weekly-trigger={weeklyRing ? true : undefined}
        // The name carries the visible balance, so voice control can say it.
        aria-label={[
          'Usage indicator',
          weeklyPercent !== undefined
            ? `${formatUsagePercent(weeklyPercent)} of weekly limit used`
            : null,
          balanceText,
        ]
          .filter((part) => part !== null)
          .join(', ')}
        aria-busy={balancePending ? true : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="usage-indicator"
      >
        {responseUsage ? (
          balance ? null : (
            'Usage'
          )
        ) : weeklyRing ? (
          <WeeklyRing
            value={ringPercent}
            tone={ringTone}
            text={formatUsagePercent(weeklyPercent ?? 0)}
          />
        ) : (
          <ProgressRing value={ringPercent} tone={ringTone} />
        )}
        {balance && (
          <CreditBalanceFigure
            testId="usage-indicator-credit-balance"
            text={balanceText}
          />
        )}
      </button>

      {open && (
        // The details load on first open; the shared menu surface places
        // and dismisses them once they arrive. Until then Escape and a press
        // outside are handled above.
        <Suspense fallback={null}>
          <UsagePopover
            usage={usage}
            modelLabel={modelLabel ?? usage.model}
            percentage={percentage}
            isCodex={isCodex}
            showContextWindow={showContextWindow}
            responseUsage={responseUsage}
            accountUsage={accountSection}
            contextBreakdown={contextBreakdown}
            costPreview={costPreview}
            hideCost={hideCost}
            contextWindowControl={contextWindowControl}
            longContextThresholdTokens={longContextThresholdTokens}
            onSeeDetails={
              onSeeDetails
                ? (): void => {
                    setOpen(false);
                    onSeeDetails();
                  }
                : undefined
            }
            onClose={closePopover}
            anchorRef={containerRef}
            {...(alignRef ? { alignRef } : {})}
            returnFocusRef={triggerRef}
            popoverRef={popoverRef}
          />
        </Suspense>
      )}
    </div>
  );
}
