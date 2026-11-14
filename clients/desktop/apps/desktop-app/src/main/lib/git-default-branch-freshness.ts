import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getGitDefaultBranchFreshnessFilePath } from './paths';

const FILE_VERSION = 2;
const MAX_ENTRIES = 2_000;

export interface GitDefaultBranchFreshnessIdentity {
  commonDir: string;
  originUrl: string;
}

export interface GitDefaultBranchFreshnessEntry extends GitDefaultBranchFreshnessIdentity {
  defaultBranch: string;
  resolvedAt: string;
}

interface PersistedGitDefaultBranchFreshnessEntry {
  commonDir: string;
  originHash: string;
  defaultBranch: string;
  resolvedAt: string;
}

interface GitDefaultBranchFreshnessFile {
  version: 2;
  entries: Record<string, PersistedGitDefaultBranchFreshnessEntry>;
}

let loadedFile: GitDefaultBranchFreshnessFile | null = null;
let loadPromise: Promise<GitDefaultBranchFreshnessFile> | null = null;
let writeChain = Promise.resolve();

function readProperty(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

function entryKey(
  identity: Pick<GitDefaultBranchFreshnessIdentity, 'commonDir'>,
): string {
  return createHash('sha256').update(identity.commonDir).digest('hex');
}

function hashOriginUrl(originUrl: string): string {
  return createHash('sha256').update(originUrl).digest('hex');
}

function parseEntry(
  value: unknown,
): PersistedGitDefaultBranchFreshnessEntry | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const commonDir = readProperty(value, 'commonDir');
  const originHash = readProperty(value, 'originHash');
  const defaultBranch = readProperty(value, 'defaultBranch');
  const resolvedAt = readProperty(value, 'resolvedAt');
  if (
    typeof commonDir !== 'string' ||
    typeof originHash !== 'string' ||
    typeof defaultBranch !== 'string' ||
    !defaultBranch ||
    typeof resolvedAt !== 'string' ||
    !Number.isFinite(Date.parse(resolvedAt))
  ) {
    return null;
  }
  return {
    commonDir,
    originHash,
    defaultBranch,
    resolvedAt,
  };
}

async function loadFile(): Promise<GitDefaultBranchFreshnessFile> {
  if (loadedFile) return loadedFile;
  if (loadPromise) return loadPromise;
  loadPromise = (async (): Promise<GitDefaultBranchFreshnessFile> => {
    const entries: Record<string, PersistedGitDefaultBranchFreshnessEntry> = {};
    let replaceLegacyFile = false;
    try {
      const parsed: unknown = JSON.parse(
        await readFile(getGitDefaultBranchFreshnessFilePath(), 'utf8'),
      );
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        readProperty(parsed, 'version') === FILE_VERSION
      ) {
        const rawEntries = readProperty(parsed, 'entries');
        if (
          typeof rawEntries === 'object' &&
          rawEntries !== null &&
          !Array.isArray(rawEntries)
        ) {
          for (const [key, value] of Object.entries(rawEntries)) {
            const entry = parseEntry(value);
            if (entry) entries[key] = entry;
          }
        }
      } else if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        readProperty(parsed, 'version') === 1
      ) {
        replaceLegacyFile = true;
      }
    } catch {
      // Missing and corrupt advisory state are ordinary cache misses.
    }
    loadedFile = { version: FILE_VERSION, entries };
    if (replaceLegacyFile) {
      await persistFile(loadedFile);
    }
    return loadedFile;
  })();
  return loadPromise;
}

function pruneEntries(
  entries: Record<string, PersistedGitDefaultBranchFreshnessEntry>,
): void {
  const keys = Object.keys(entries);
  if (keys.length <= MAX_ENTRIES) return;
  keys
    .sort(
      (left, right) =>
        Date.parse(entries[left]?.resolvedAt ?? '') -
        Date.parse(entries[right]?.resolvedAt ?? ''),
    )
    .slice(0, keys.length - MAX_ENTRIES)
    .forEach((key) => delete entries[key]);
}

async function persistFile(file: GitDefaultBranchFreshnessFile): Promise<void> {
  const filePath = getGitDefaultBranchFreshnessFilePath();
  await mkdir(dirname(filePath), { recursive: true });
  pruneEntries(file.entries);
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export async function readGitDefaultBranchFreshness(
  identity: GitDefaultBranchFreshnessIdentity,
): Promise<GitDefaultBranchFreshnessEntry | null> {
  await writeChain;
  const file = await loadFile();
  const entry = file.entries[entryKey(identity)];
  if (
    !entry ||
    entry.commonDir !== identity.commonDir ||
    entry.originHash !== hashOriginUrl(identity.originUrl)
  ) {
    return null;
  }
  return {
    commonDir: identity.commonDir,
    originUrl: identity.originUrl,
    defaultBranch: entry.defaultBranch,
    resolvedAt: entry.resolvedAt,
  };
}

export async function recordGitDefaultBranch(args: {
  identity: GitDefaultBranchFreshnessIdentity;
  defaultBranch: string;
  resolvedAt: number;
}): Promise<void> {
  writeChain = writeChain
    .catch(() => undefined)
    .then(async () => {
      const file = await loadFile();
      file.entries[entryKey(args.identity)] = {
        commonDir: args.identity.commonDir,
        originHash: hashOriginUrl(args.identity.originUrl),
        defaultBranch: args.defaultBranch,
        resolvedAt: new Date(args.resolvedAt).toISOString(),
      };
      await persistFile(file);
    });
  await writeChain;
}
