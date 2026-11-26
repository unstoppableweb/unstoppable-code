import type {
  OrgTranscriptAccessEvent,
  OrgTranscriptExport,
  OrgTranscriptMember,
} from '@canopy/protocol/canopy-core/core';
import type { OrganizationTranscriptView } from '@canopy/protocol/settings';

/** The Sessions and export date ranges the filter offers, in days. */
export const TRANSCRIPT_RANGE_PRESETS = [7, 30, 90, 365] as const;
export type TranscriptRangePreset = (typeof TRANSCRIPT_RANGE_PRESETS)[number];
export const DEFAULT_TRANSCRIPT_RANGE: TranscriptRangePreset = 30;

const RANGE_LABELS: Readonly<Record<TranscriptRangePreset, string>> = {
  7: 'Last 7 days',
  30: 'Last 30 days',
  90: 'Last 90 days',
  365: 'Last 12 months',
};

export function transcriptRangeLabel(preset: TranscriptRangePreset): string {
  return RANGE_LABELS[preset];
}

export interface TranscriptRange {
  /** Inclusive ISO instant: the start of the first local day. */
  readonly from: string;
  /** Exclusive ISO instant: the start of the local day after today. */
  readonly to: string;
}

/**
 * The last `days` local days, today included, as `[from, to)` instants. The
 * server enforces the 366-day cap and `from < to`.
 */
export function transcriptRangeForPreset(
  days: TranscriptRangePreset,
  now: Date = new Date(),
): TranscriptRange {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const start = new Date(
    end.getFullYear(),
    end.getMonth(),
    end.getDate() - days,
  );
  return { from: start.toISOString(), to: end.toISOString() };
}

const MONTH_DAY = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
});
const MONTH_DAY_YEAR = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});
const TIME = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

/** "Oct 25 to Nov 24, 2026": the last day shown is the one before `to`. */
export function formatTranscriptRange(range: TranscriptRange): string {
  const from = new Date(range.from);
  const lastDay = new Date(Date.parse(range.to) - 1);
  const start =
    from.getFullYear() === lastDay.getFullYear()
      ? MONTH_DAY.format(from)
      : MONTH_DAY_YEAR.format(from);
  return `${start} to ${MONTH_DAY_YEAR.format(lastDay)}`;
}

/** "Oct 30", or "Oct 30, 2025" outside the current year. */
export function formatTranscriptDate(iso: string, now = new Date()): string {
  const date = new Date(iso);
  return date.getFullYear() === now.getFullYear()
    ? MONTH_DAY.format(date)
    : MONTH_DAY_YEAR.format(date);
}

/** "12 min ago" or "2 h ago" within a day, otherwise a date ("Oct 30"). */
export function formatTranscriptActivity(
  iso: string,
  now = new Date(),
): string {
  const elapsed = now.getTime() - Date.parse(iso);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  if (elapsed < minute) return 'Just now';
  if (elapsed < hour) return `${Math.floor(elapsed / minute)} min ago`;
  if (elapsed < 24 * hour) return `${Math.floor(elapsed / hour)} h ago`;
  return formatTranscriptDate(iso, now);
}

/** "Nov 24, 9:02 to 9:48", or both dates when the session spans days. */
export function formatSessionTimeRange(fromIso: string, toIso: string): string {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  const sameDay = from.toDateString() === to.toDateString();
  const start = `${formatTranscriptDate(fromIso)}, ${TIME.format(from)}`;
  return sameDay
    ? `${start} to ${TIME.format(to)}`
    : `${start} to ${formatTranscriptDate(toIso)}, ${TIME.format(to)}`;
}

const COST = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatTranscriptCost(usd: number | null): string {
  return usd === null ? '—' : COST.format(usd);
}

const COUNT = new Intl.NumberFormat();

export function formatCount(value: number): string {
  return COUNT.format(value);
}

/** "1 session", "214 sessions". */
export function sessionCountLabel(count: number): string {
  return `${formatCount(count)} ${count === 1 ? 'session' : 'sessions'}`;
}

/** "18 turns". */
export function turnCountLabel(count: number): string {
  return `${formatCount(count)} ${count === 1 ? 'turn' : 'turns'}`;
}

/** Decimal units, rounded to what a person compares: "38 MB", "1.2 GB". */
export function formatTranscriptBytes(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB'] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  if (unit === 0) return `${formatCount(bytes)} bytes`;
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/** Display name for a member, or "Former member" for a deleted account. */
export function memberName(member: OrgTranscriptMember | null): string {
  return member?.name ?? 'Former member';
}

/** "Transcripts", "Transcripts, plans", "Transcripts, plans, summaries". */
export function exportIncludesLabel(
  item: Pick<OrgTranscriptExport, 'includePlans' | 'includeSummaries'>,
): string {
  const parts = ['Transcripts'];
  if (item.includePlans) parts.push('plans');
  if (item.includeSummaries) parts.push('summaries');
  return parts.join(', ');
}

/** "expires in 3 days", "expires today". */
export function exportExpiryLabel(expiresAt: string, now = new Date()): string {
  const days = Math.ceil(
    (Date.parse(expiresAt) - now.getTime()) / (24 * 60 * 60 * 1000),
  );
  if (days <= 0) return 'expires today';
  return days === 1 ? 'expires in 1 day' : `expires in ${days} days`;
}

const FAILURE_REASONS: Readonly<
  Record<NonNullable<OrgTranscriptExport['failureReason']>, string>
> = {
  unreadable: "couldn't read stored transcripts",
  too_large: 'too large',
  storage_unavailable: 'storage unavailable',
};

export function exportFailureReason(
  reason: OrgTranscriptExport['failureReason'],
): string | null {
  return reason === null ? null : FAILURE_REASONS[reason];
}

const FORMAT_LABELS = { md: 'Markdown', jsonl: 'JSONL' } as const;

/**
 * The action sentence of an access-history row, after the actor's name:
 * "viewed Priya Shah's session", with the branch rendered by the caller.
 */
export interface AccessEventSentence {
  readonly before: string;
  /** The branch, set in monospace. */
  readonly branch: string | null;
  readonly after: string;
}

export function accessEventSentence(
  event: OrgTranscriptAccessEvent,
): AccessEventSentence {
  const subject = `${memberName(event.subject)}'s session`;
  const exportDate =
    event.exportRequestedAt === null
      ? null
      : formatTranscriptDate(event.exportRequestedAt);
  switch (event.type) {
    case 'session_viewed':
      return {
        before: `viewed ${subject}`,
        branch: event.sessionBranchName,
        after: '',
      };
    case 'session_downloaded':
      return {
        before: `downloaded ${subject}`,
        branch: event.sessionBranchName,
        after: event.format === null ? '' : `(${FORMAT_LABELS[event.format]})`,
      };
    case 'export_requested':
      return {
        before:
          event.sessionCount === null
            ? 'started an export'
            : `started an export of ${sessionCountLabel(event.sessionCount)}`,
        branch: null,
        after: '',
      };
    case 'export_downloaded':
      return {
        before:
          exportDate === null
            ? 'downloaded an export'
            : `downloaded the export from ${exportDate}`,
        branch: null,
        after: '',
      };
    case 'export_deleted':
      return {
        before:
          exportDate === null
            ? 'deleted an export'
            : `deleted the export from ${exportDate}`,
        branch: null,
        after: '',
      };
  }
}

/** Initials for an avatar: "PS" for "Priya Shah". */
export function memberInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

/** The page path of a Transcripts view. */
export function transcriptsViewHref(
  orgId: string,
  view: OrganizationTranscriptView,
): string {
  const base = `/organization/${orgId}/transcripts`;
  return view === 'sessions' ? base : `${base}/${view}`;
}

export function transcriptSessionHref(
  orgId: string,
  sessionId: string,
): string {
  return `/organization/${orgId}/transcripts/sessions/${sessionId}`;
}

function encoded(segment: string): string {
  return encodeURIComponent(segment);
}

/** The authenticated single-session download route. */
export function sessionDownloadPath(
  orgId: string,
  sessionId: string,
  format: 'md' | 'jsonl',
): string {
  return `/api/v1/settings/organization/${encoded(orgId)}/transcripts/sessions/${encoded(sessionId)}/download?format=${format}`;
}

/** The authenticated export download route. */
export function exportDownloadPath(orgId: string, exportId: string): string {
  return `/api/v1/settings/organization/${encoded(orgId)}/transcripts/exports/${encoded(exportId)}/download`;
}
