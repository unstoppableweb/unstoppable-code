export interface ConditionalCacheEntry<T> {
  etag: string;
  data: T;
  lastUsedAt: number;
}

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_IDLE_TTL_MS = 30 * 60_000;

export class GitHubConditionalCache {
  private entries = new Map<string, ConditionalCacheEntry<unknown>>();

  constructor(
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
    private readonly idleTtlMs = DEFAULT_IDLE_TTL_MS,
  ) {}

  get<T>(
    key: string,
    isData: (value: unknown) => value is T,
    now = Date.now(),
  ): ConditionalCacheEntry<T> | undefined {
    this.prune(now);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const data = entry.data;
    if (!isData(data)) {
      this.entries.delete(key);
      return undefined;
    }
    entry.lastUsedAt = now;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { etag: entry.etag, data, lastUsedAt: entry.lastUsedAt };
  }

  set<T>(key: string, etag: string, data: T, now = Date.now()): void {
    this.prune(now);
    this.entries.delete(key);
    this.entries.set(key, { etag, data, lastUsedAt: now });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private prune(now: number): void {
    for (const [key, entry] of Array.from(this.entries.entries())) {
      if (now - entry.lastUsedAt > this.idleTtlMs) {
        this.entries.delete(key);
      }
    }
  }
}
