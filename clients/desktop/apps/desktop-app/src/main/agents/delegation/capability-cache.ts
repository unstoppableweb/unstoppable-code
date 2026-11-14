import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

export interface DelegationCapabilityTreeKey {
  readonly harness:
    | 'claude'
    | 'codex'
    | 'cursor'
    | 'copilot'
    | 'antigravity'
    | 'opencode';
  readonly identity: string;
  readonly directory: string;
}

interface CacheEntry {
  readonly files: ReadonlyMap<string, string>;
  readonly bytes: number;
}

interface PendingDirectory {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly depth: number;
}

interface DigestEntry {
  readonly relativePath: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
}

const DEFAULT_MAX_ENTRIES = 64;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const MAX_DIGEST_FILES = 257;
const MAX_DIGEST_DIRECTORIES = 256;
const MAX_DIGEST_DEPTH = 12;
const SKIPPED_DIRECTORIES = new Set(['.git', '.hg', '.svn']);

function boundedLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function cacheKey(key: DelegationCapabilityTreeKey, digest: string): string {
  return JSON.stringify([key.harness, key.identity, digest]);
}

function copiedMap(
  files: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  return new Map(files);
}

/**
 * Content-metadata keyed LRU for immutable source trees used by delegation.
 * Each caller receives a copy, so materializers can never mutate cached data.
 */
export class DelegationCapabilityCache {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly digest: (directory: string) => Promise<string | undefined>;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<
    string,
    Promise<ReadonlyMap<string, string>>
  >();
  private totalBytes = 0;
  private generation = 0;

  constructor(options?: {
    readonly maxEntries?: number;
    readonly maxBytes?: number;
    readonly digest?: (directory: string) => Promise<string | undefined>;
  }) {
    this.maxEntries = boundedLimit(options?.maxEntries, DEFAULT_MAX_ENTRIES);
    this.maxBytes = boundedLimit(options?.maxBytes, DEFAULT_MAX_BYTES);
    this.digest = options?.digest ?? installedContentDigest;
  }

  /** Read once per identity/content key, sharing concurrent reads. */
  async readTree(
    key: DelegationCapabilityTreeKey,
    read: () => Promise<ReadonlyMap<string, string>>,
  ): Promise<ReadonlyMap<string, string>> {
    const generation = this.generation;
    const digest = await this.digest(key.directory);
    if (digest === undefined || generation !== this.generation)
      return copiedMap(await read());

    const encodedKey = cacheKey(key, digest);
    const cached = this.entries.get(encodedKey);
    if (cached) {
      this.touch(encodedKey, cached);
      return copiedMap(cached.files);
    }

    const pending = this.inFlight.get(encodedKey);
    if (pending) return copiedMap(await pending);

    const readPromise = Promise.resolve()
      .then(read)
      .then((source): ReadonlyMap<string, string> => {
        const files = new Map(source);
        if (generation === this.generation) this.store(encodedKey, files);
        return files;
      });
    this.inFlight.set(encodedKey, readPromise);
    try {
      return copiedMap(await readPromise);
    } finally {
      if (this.inFlight.get(encodedKey) === readPromise)
        this.inFlight.delete(encodedKey);
    }
  }

  /** Drop cache and pending entries; pending reads cannot repopulate it. */
  clear(): void {
    this.generation += 1;
    this.entries.clear();
    this.inFlight.clear();
    this.totalBytes = 0;
  }

  private touch(key: string, entry: CacheEntry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private store(key: string, files: ReadonlyMap<string, string>): void {
    let bytes = 0;
    for (const content of Array.from(files.values()))
      bytes += Buffer.byteLength(content, 'utf8');
    if (this.maxEntries === 0 || bytes > this.maxBytes) return;

    const previous = this.entries.get(key);
    if (previous) {
      this.totalBytes -= previous.bytes;
      this.entries.delete(key);
    }
    this.entries.set(key, { files: copiedMap(files), bytes });
    this.totalBytes += bytes;

    while (
      this.entries.size > this.maxEntries ||
      this.totalBytes > this.maxBytes
    ) {
      const oldestKey = Array.from(this.entries.keys())[0];
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey);
      if (oldest) this.totalBytes -= oldest.bytes;
      this.entries.delete(oldestKey);
    }
  }
}

/** Digest a bounded filesystem tree without following or exposing paths. */
export async function installedContentDigest(
  directory: string,
): Promise<string | undefined> {
  try {
    const root = await fs.lstat(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) return undefined;

    const entries: DigestEntry[] = [
      {
        relativePath: '',
        size: root.size,
        mtimeMs: root.mtimeMs,
        ino: root.ino,
      },
    ];
    const pending: PendingDirectory[] = [
      { relativePath: '', absolutePath: directory, depth: 0 },
    ];
    let files = 0;
    let directories = 1;

    while (pending.length > 0) {
      const current = pending.shift();
      if (!current) break;
      const children = await fs.readdir(current.absolutePath, {
        withFileTypes: true,
      });
      for (const child of children) {
        if (SKIPPED_DIRECTORIES.has(child.name)) continue;
        const relativePath = current.relativePath
          ? path.posix.join(current.relativePath, child.name)
          : child.name;
        const absolutePath = path.join(current.absolutePath, child.name);
        const stat = await fs.lstat(absolutePath);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          const depth = current.depth + 1;
          if (depth > MAX_DIGEST_DEPTH) return undefined;
          directories += 1;
          if (directories > MAX_DIGEST_DIRECTORIES) return undefined;
          entries.push({
            relativePath,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            ino: stat.ino,
          });
          pending.push({ relativePath, absolutePath, depth });
          continue;
        }
        if (!stat.isFile()) continue;
        files += 1;
        if (files > MAX_DIGEST_FILES) return undefined;
        entries.push({
          relativePath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ino: stat.ino,
        });
      }
    }

    const body = entries
      .sort((left, right) => {
        if (left.relativePath < right.relativePath) return -1;
        if (left.relativePath > right.relativePath) return 1;
        return 0;
      })
      .map(
        (entry) =>
          `${entry.relativePath}\0${entry.size}\0${entry.mtimeMs}\0` +
          entry.ino,
      )
      .join('\n');
    return createHash('sha256').update(body).digest('hex');
  } catch {
    return undefined;
  }
}
