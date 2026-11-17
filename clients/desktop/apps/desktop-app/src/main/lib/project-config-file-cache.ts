import type { BigIntStats } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import {
  getProjectConfigFileCandidates,
  parseCanopyJson,
} from '@canopy/desktop-shared/node/lib/canopy-json';
import type { CanopyJsonFile } from '@canopy/desktop-shared/types';
import { recordMetadataRead } from '@canopy/desktop-shared/node/work-counters';
import { isMissingFileError } from './fs-utils';
import {
  getConductorJsonPath,
  parseConductorJson,
  type ConductorJsonScripts,
} from './conductor-json';

/**
 * CAN-6933: parsed project config files (canopy.json candidates and
 * conductor.json), keyed by the identity of the file they came from. Every
 * request stats the file. Any change of device, inode, size, modification or
 * change time re-reads it, and a stat error drops the entry and is never
 * answered from the cache. A missing file is re-stated on every request.
 */
const ENTRY_LIMIT = 512;

type CachedRead<T> =
  | { readonly state: 'absent' }
  | { readonly state: 'present'; readonly value: T };

function identityOf(info: BigIntStats): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

class ConfigFileCache<T> {
  private readonly entries = new Map<
    string,
    { readonly identity: string; readonly value: T }
  >();

  public constructor(
    private readonly file: string,
    private readonly parse: (raw: string, path: string) => T,
  ) {}

  public async read(path: string): Promise<CachedRead<T>> {
    recordMetadataRead(`config.stat.${this.file}`);
    let before: BigIntStats;
    try {
      before = await stat(path, { bigint: true });
    } catch (error) {
      this.entries.delete(path);
      if (isMissingFileError(error)) return { state: 'absent' };
      throw error;
    }
    const identity = identityOf(before);
    const cached = this.entries.get(path);
    this.entries.delete(path);
    if (cached?.identity === identity) {
      this.remember(path, cached);
      // Callers own what they receive; the cached parse stays untouched.
      return { state: 'present', value: structuredClone(cached.value) };
    }
    recordMetadataRead(`config.read.${this.file}`);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if (isMissingFileError(error)) return { state: 'absent' };
      throw error;
    }
    const value = this.parse(raw, path);
    // A file replaced while it was read keeps no entry.
    const after = await stat(path, { bigint: true }).catch(() => null);
    if (after && identityOf(after) === identity)
      this.remember(path, { identity, value: structuredClone(value) });
    return { state: 'present', value };
  }

  public clear(): void {
    this.entries.clear();
  }

  private remember(
    path: string,
    entry: { readonly identity: string; readonly value: T },
  ): void {
    this.entries.set(path, entry);
    while (this.entries.size > ENTRY_LIMIT) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

const canopyJsonFiles = new ConfigFileCache<CanopyJsonFile>(
  'project-config',
  parseCanopyJson,
);
const conductorJsonFiles = new ConfigFileCache<ConductorJsonScripts | null>(
  'conductor',
  (raw) => parseConductorJson(raw),
);

/**
 * The first existing canopy.json candidate for `repoPath`, parsed, as
 * `readCanopyJson` reads it. Candidates are checked in order on every call,
 * so a newly added higher-priority file wins at once.
 */
export async function readCachedCanopyJson(
  repoPath: string,
): Promise<CanopyJsonFile | null> {
  for (const candidate of getProjectConfigFileCandidates(repoPath)) {
    const read = await canopyJsonFiles.read(candidate);
    if (read.state === 'present') return read.value;
  }
  return null;
}

/** conductor.json for `repoPath`, parsed, as `readConductorJson` reads it. */
export async function readCachedConductorJson(
  repoPath: string,
): Promise<ConductorJsonScripts | null> {
  const read = await conductorJsonFiles.read(getConductorJsonPath(repoPath));
  return read.state === 'present' ? read.value : null;
}

export function __resetProjectConfigFileCacheForTests(): void {
  canopyJsonFiles.clear();
  conductorJsonFiles.clear();
}
