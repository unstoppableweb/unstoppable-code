'use client';

import { CodeBlock } from './CodeBlock';
import { useEffect, useState, type JSX } from 'react';
import { Notice, NoticeButton } from './Notice';

// Browsers fire a longer `setTimeout` at once; a farther deadline is
// re-checked after this delay instead.
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Epoch milliseconds of a retry deadline, or null when absent/unparseable. */
export function parseUsageRetryAt(retryAt: string | undefined): number | null {
  if (!retryAt) {
    return null;
  }
  const at = Date.parse(retryAt);
  return Number.isFinite(at) ? at : null;
}

/**
 * Whether a usage retry must still wait for `retryAt` (the time before which
 * the main process will not ask the provider again). Re-renders on its own
 * when the deadline passes; the pending timer is cleared on unmount or when
 * `retryAt` changes. Absent or unparseable deadlines never wait.
 */
export function useUsageRetryWait(retryAt: string | undefined): boolean {
  const retryAtMs = parseUsageRetryAt(retryAt);
  const [tick, setTick] = useState(0);
  const waiting = retryAtMs !== null && Date.now() < retryAtMs;

  useEffect(() => {
    if (retryAtMs === null) {
      return undefined;
    }
    const remaining = retryAtMs - Date.now();
    if (remaining <= 0) {
      return undefined;
    }
    const timer = setTimeout(
      (): void => setTick((tick) => tick + 1),
      Math.min(remaining, MAX_TIMEOUT_MS),
    );
    return (): void => clearTimeout(timer);
    // `tick` re-arms the timer after a clamped (far-future) delay fires.
  }, [retryAtMs, tick]);

  return waiting;
}

/** The short title that leads the line; the headline follows it. */
function titleForKind(kind: UsageErrorNoticeProps['info']['kind']): string {
  switch (kind) {
    case 'auth':
      return 'Sign-in expired';
    case 'network':
      return 'No connection';
    case 'service':
      return 'Usage unavailable';
    case 'rate_limited':
      return 'Usage checks paused';
    case 'unsupported':
      return 'Usage not available';
    case 'unknown':
      return 'Usage not loaded';
  }
}

export interface UsageErrorNoticeProps {
  /** Human label of the usage source, e.g. `Claude`, `Codex`, `AI Credits`. */
  label: string;
  /** Prefix for the notice's stable test ids: `<prefix>-error[-retry|…]`. */
  testIdPrefix: string;
  info: {
    kind:
      | 'auth'
      | 'network'
      | 'service'
      | 'rate_limited'
      | 'unsupported'
      | 'unknown';
    message?: string;
    detail?: string;
    retryAt?: string;
  };
  /** Host supplies source-specific fallback copy and locale-aware time display. */
  defaultHeadline: string;
  formatRetryTimeLabel: (at: string | undefined) => string | null;
  /** Re-run the failed fetch. Omitted (or kind `unsupported`) hides the action. */
  onRetry?: () => void;
  /** Disables the retry action while a refresh is already in flight. */
  retrying?: boolean;
  /** The surface still shows the last windows the provider reported. */
  showingRetainedUsage?: boolean;
  /** Panel-optimized spacing, mirroring the usage cards' prop. */
  frameless?: boolean;
}

/**
 * Friendly callout for a failed usage/rate-limit fetch, shared by the
 * provider usage cards and the AI Credits card. Renders classified copy with
 * a retry affordance instead of the raw provider/transport message; the raw
 * text stays available behind a "Show details" action beside Retry (a
 * secondary notice button, not a text link) and expands under the message
 * for diagnostics.
 */
export function UsageErrorNotice({
  label,
  testIdPrefix,
  info,
  defaultHeadline,
  formatRetryTimeLabel,
  onRetry,
  retrying = false,
  showingRetainedUsage = false,
  frameless = false,
}: UsageErrorNoticeProps): JSX.Element {
  const [detailsOpen, setDetailsOpen] = useState(false);

  const isRateLimited = info.kind === 'rate_limited';
  const retryAt = isRateLimited ? info.retryAt : undefined;
  const waitingForRetry = useUsageRetryWait(retryAt);
  const retryAtMs = parseUsageRetryAt(retryAt);
  const retryTimeLabel =
    retryAtMs !== null && waitingForRetry
      ? formatRetryTimeLabel(retryAt)
      : null;
  const retrySentence =
    retryAtMs === null
      ? undefined
      : waitingForRetry
        ? retryTimeLabel === null
          ? undefined
          : `You can try again after ${retryTimeLabel}.`
        : 'You can try again now.';
  const headline =
    info.message ??
    (isRateLimited && retrySentence
      ? `${label} is limiting usage checks right now.`
      : defaultHeadline);
  const message = isRateLimited
    ? [
        headline,
        ...(showingRetainedUsage
          ? [`These are the last numbers ${label} reported.`]
          : []),
        ...(retrySentence ? [retrySentence] : []),
      ].join(' ')
    : headline;
  const detail =
    info.detail && info.detail !== headline ? info.detail : undefined;
  const detailsId = `${testIdPrefix}-error-details`;
  // Retrying an account/plan that has no usage data cannot succeed; the
  // header refresh remains available for the skeptical.
  const showRetry = Boolean(onRetry) && info.kind !== 'unsupported';

  return (
    <div className={frameless ? 'pt-2' : 'pt-4'}>
      <Notice
        intent="attention"
        title={titleForKind(info.kind)}
        data-testid={`${testIdPrefix}-error`}
        {...(detail || showRetry
          ? {
              actions: (
                <>
                  {detail && (
                    <NoticeButton
                      variant="secondary"
                      data-testid={`${testIdPrefix}-error-details-toggle`}
                      aria-expanded={detailsOpen}
                      // Only while open: the raw error is unmounted when
                      // collapsed, and `aria-controls` must name an element
                      // that exists.
                      {...(detailsOpen ? { 'aria-controls': detailsId } : {})}
                      onClick={(): void => setDetailsOpen((open) => !open)}
                    >
                      {detailsOpen ? 'Hide details' : 'Show details'}
                    </NoticeButton>
                  )}
                  {showRetry && (
                    <NoticeButton
                      variant="secondary"
                      data-testid={`${testIdPrefix}-error-retry`}
                      onClick={onRetry}
                      busy={retrying}
                      busyLabel="Trying again…"
                      // Keeps the pressed button focusable while it runs.
                      aria-disabled={retrying || undefined}
                      disabled={isRateLimited && waitingForRetry}
                    >
                      Try again
                    </NoticeButton>
                  )}
                </>
              ),
            }
          : {})}
        {...(detail && detailsOpen
          ? {
              detail: (
                <CodeBlock
                  id={detailsId}
                  data-testid={`${testIdPrefix}-error-details`}
                  variant="error-detail"
                  size="2xs"
                  wrap="all"
                  tone="tertiary"
                  replay="inherit"
                  selectable
                  className="max-h-28"
                >
                  {detail}
                </CodeBlock>
              ),
            }
          : {})}
      >
        {message}
      </Notice>
    </div>
  );
}
