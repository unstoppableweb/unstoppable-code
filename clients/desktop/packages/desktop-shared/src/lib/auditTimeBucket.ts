import type {
  AgentAuditEntry,
  UsageTimeseriesBucket,
  UsageTimeseriesRequest,
} from '../types';

export type AuditTimeBucketGranularity = UsageTimeseriesRequest['bucket'];

export interface AuditTimeBucketRange {
  startDate: string;
  endDate: string;
}

type AuditTimeBucketEntry = Pick<
  AgentAuditEntry,
  'provider' | 'startedAt' | 'tokens'
>;

function createEmptyProviderTotals(): UsageTimeseriesBucket['providers'] {
  return {
    claude: { in: 0, out: 0 },
    codex: { in: 0, out: 0 },
    ollama: { in: 0, out: 0 },
    cursor: { in: 0, out: 0 },
    copilot: { in: 0, out: 0 },
    antigravity: { in: 0, out: 0 },
    opencode: { in: 0, out: 0 },
  };
}

function parseTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function bucketStartForDate(
  date: Date,
  granularity: AuditTimeBucketGranularity,
): string {
  const bucketStart = new Date(date.getTime());
  switch (granularity) {
    case 'hour':
      return new Date(
        date.getTime() -
          date.getMinutes() * 60 * 1000 -
          date.getSeconds() * 1000 -
          date.getMilliseconds(),
      ).toISOString();
    case 'day':
      bucketStart.setHours(0, 0, 0, 0);
      break;
    case 'week': {
      bucketStart.setHours(0, 0, 0, 0);
      const dayOfWeek = bucketStart.getDay();
      const daysSinceMonday = (dayOfWeek + 6) % 7;
      bucketStart.setDate(bucketStart.getDate() - daysSinceMonday);
      break;
    }
  }
  return bucketStart.toISOString();
}

function cloneBucket(bucket: UsageTimeseriesBucket): UsageTimeseriesBucket {
  return {
    bucketStart: bucket.bucketStart,
    providers: {
      claude: { ...bucket.providers.claude },
      codex: { ...bucket.providers.codex },
      ollama: { ...bucket.providers.ollama },
      cursor: { ...bucket.providers.cursor },
      copilot: { ...bucket.providers.copilot },
      antigravity: { ...bucket.providers.antigravity },
      opencode: { ...bucket.providers.opencode },
    },
  };
}

export function bucketEntries(
  entries: readonly AuditTimeBucketEntry[],
  granularity: AuditTimeBucketGranularity,
  range: AuditTimeBucketRange,
): UsageTimeseriesBucket[] {
  const startTime = parseTimestamp(range.startDate);
  const endTime = parseTimestamp(range.endDate);
  if (startTime === null || endTime === null || startTime >= endTime) {
    return [];
  }

  const buckets = new Map<string, UsageTimeseriesBucket>();

  for (const entry of entries) {
    const startedAt = parseTimestamp(entry.startedAt);
    if (startedAt === null || startedAt < startTime || startedAt >= endTime) {
      continue;
    }

    const bucketStart = bucketStartForDate(new Date(startedAt), granularity);
    let bucket = buckets.get(bucketStart);
    if (!bucket) {
      bucket = {
        bucketStart,
        providers: createEmptyProviderTotals(),
      };
      buckets.set(bucketStart, bucket);
    }

    const providerTotals = bucket.providers[entry.provider];
    providerTotals.in += entry.tokens.input;
    providerTotals.out += entry.tokens.output;
  }

  return Array.from(buckets.values())
    .sort((left, right) => left.bucketStart.localeCompare(right.bucketStart))
    .map((bucket) => cloneBucket(bucket));
}
