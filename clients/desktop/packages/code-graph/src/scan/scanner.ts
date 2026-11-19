import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { canonicalRelativePath } from '../ids';
import { grammarForPath } from '../grammars/registry';
import { nonCodeExtractorForPath } from '../extract/extractor-registry';
import { isMissingPathError, isResourceExhaustionError } from '../io-failure';

const execFileAsync = promisify(execFile);

export interface ScannedSourceFile {
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  mtimeNs: string;
}

export const CODE_GRAPH_DEFAULT_IGNORED_DIRECTORIES: readonly string[] = [
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  'coverage',
  '.cache',
  '.next',
];

export function computeContentHash(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function statScanned(
  rootPath: string,
  relativePath: string,
): Promise<ScannedSourceFile | null> {
  const absolutePath = path.join(rootPath, relativePath);
  try {
    const stats = await fs.lstat(absolutePath, { bigint: true });
    if (!stats.isFile()) {
      return null;
    }
    return {
      relativePath: canonicalRelativePath(relativePath),
      absolutePath,
      sizeBytes: Number(stats.size),
      mtimeNs: String(stats.mtimeNs),
    };
  } catch (error) {
    // Only a missing path vanished between listing and stat; any other
    // error is not "gone" and reaches the caller.
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

function isWithinIgnoredDirectory(relativePath: string): boolean {
  return relativePath
    .split('/')
    .some((segment) =>
      CODE_GRAPH_DEFAULT_IGNORED_DIRECTORIES.includes(segment),
    );
}

async function enumerateViaGit(rootPath: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'git',
    [
      '-C',
      rootPath,
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
    ],
    { maxBuffer: 128 * 1024 * 1024, timeout: 30_000 },
  );
  return stdout.split('\0').filter((entry) => entry.length > 0);
}

async function enumerateViaWalk(rootPath: string): Promise<string[]> {
  const results: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!CODE_GRAPH_DEFAULT_IGNORED_DIRECTORIES.includes(entry.name)) {
          await walk(absolute);
        }
      } else if (entry.isFile()) {
        results.push(path.relative(rootPath, absolute));
      }
    }
  };
  await walk(rootPath);
  return results;
}

export interface EnumerateSourceFilesOptions {
  onDisposition?: (
    path: string,
    disposition: 'eligible' | 'unsupported' | 'excluded',
  ) => void;
  // Validated CUSTOM language extensions from the worktree's
  // `.canopy/code-graph/languages.json` (Phase 6 Task 8): the per-ENGINE
  // additions to the built-in grammar + non-code extension corpus. Already
  // normalized (lowercase, leading dot) by languages/custom-config.ts, and
  // matched with the same endsWith convention `grammarForPath` uses.
  customExtensions?: readonly string[];
  /**
   * A listed file that exists but could not be stat'ed (for example EACCES).
   * It is left out of the result; the caller keeps its prior facts. Without
   * this callback the error rejects the scan.
   */
  onUnreadable?: (relativePath: string) => void;
}

function matchesCustomExtension(
  relativePath: string,
  customExtensions: readonly string[] | undefined,
): boolean {
  if (customExtensions === undefined || customExtensions.length === 0) {
    return false;
  }
  const lower = relativePath.toLowerCase();
  return customExtensions.some((extension) => lower.endsWith(extension));
}

export async function enumerateSourceFiles(
  rootPath: string,
  options?: EnumerateSourceFilesOptions,
): Promise<ScannedSourceFile[]> {
  let listed: string[];
  try {
    listed = await enumerateViaGit(rootPath);
  } catch {
    listed = await enumerateViaWalk(rootPath);
  }
  const candidates: string[] = [];
  for (const entry of Array.from(new Set(listed)).sort()) {
    const relativePath = canonicalRelativePath(entry);
    const disposition = isWithinIgnoredDirectory(relativePath)
      ? 'excluded'
      : grammarForPath(relativePath) !== undefined ||
          nonCodeExtractorForPath(relativePath) !== undefined ||
          matchesCustomExtension(relativePath, options?.customExtensions)
        ? 'eligible'
        : 'unsupported';
    options?.onDisposition?.(relativePath, disposition);
    if (disposition === 'eligible') candidates.push(relativePath);
  }
  const scanned: ScannedSourceFile[] = [];
  for (const relativePath of candidates) {
    let entry: ScannedSourceFile | null;
    try {
      entry = await statScanned(rootPath, relativePath);
    } catch (error) {
      if (isResourceExhaustionError(error) || !options?.onUnreadable)
        throw error;
      options.onUnreadable(relativePath);
      continue;
    }
    if (entry !== null) {
      scanned.push(entry);
    }
  }
  scanned.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return scanned;
}

export interface CodeGraphFileWorkPlan {
  toParse: ScannedSourceFile[];
  toRemove: string[];
  unchanged: number;
}

export function planFileWork(
  scanned: readonly ScannedSourceFile[],
  existing: readonly {
    relativePath: string;
    sizeBytes: number;
    mtimeNs: string;
  }[],
  options: { forceFullReparse: boolean },
): CodeGraphFileWorkPlan {
  const existingByPath = new Map(
    existing.map((entry) => [entry.relativePath, entry]),
  );
  const scannedPaths = new Set(scanned.map((entry) => entry.relativePath));
  const toParse: ScannedSourceFile[] = [];
  let unchanged = 0;
  for (const entry of scanned) {
    const prior = existingByPath.get(entry.relativePath);
    const statMatches =
      prior !== undefined &&
      prior.sizeBytes === entry.sizeBytes &&
      prior.mtimeNs === entry.mtimeNs;
    if (statMatches && !options.forceFullReparse) {
      unchanged += 1;
    } else {
      toParse.push(entry);
    }
  }
  const toRemove = existing
    .map((entry) => entry.relativePath)
    .filter((relativePath) => !scannedPaths.has(relativePath))
    .sort();
  return { toParse, toRemove, unchanged };
}
