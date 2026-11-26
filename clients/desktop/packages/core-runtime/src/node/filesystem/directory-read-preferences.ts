import { readFile } from 'node:fs/promises';
import {
  createDefaultFileIndexingPreferences,
  type FileIndexingPreferences,
} from '@canopy/protocol/file-indexing';
import { readPreferencesEnvelopeRecord } from '@canopy/protocol/preferences';
import { normalizeFileIndexingPreferences } from './file-indexing';

const DIRECTORY_PRIMARY_PREFERENCES_FILE_NAME = 'preferences.json';
const DIRECTORY_LAST_GOOD_PREFERENCES_FILE_NAME = 'preferences.last-good.json';

export interface DirectoryReadPreferences {
  readonly fileIndexing: FileIndexingPreferences;
  /** Saved verbatim; Git selection owns trimming. */
  readonly gitExecutablePath: string;
}

export interface DirectoryReadPreferenceSnapshot {
  readonly source: 'primary' | 'last-good' | 'defaults';
  readonly preferences: DirectoryReadPreferences;
}

export interface DirectoryReadPreferenceSource {
  read(
    this: void,
    signal: AbortSignal,
  ): Promise<DirectoryReadPreferenceSnapshot>;
}

export interface DirectoryReadPreferenceSourceOptions {
  /**
   * Trusted-host precondition: the host has already resolved this to the
   * canonical data root. `isAbsolute` below only rejects obvious misuse.
   */
  readonly canonicalDataRoot: string;
  readonly paths: {
    join(this: void, ...parts: string[]): string;
    isAbsolute(this: void, value: string): boolean;
  };
  readonly readFile?: (
    this: void,
    absolutePath: string,
    signal: AbortSignal,
  ) => Promise<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readUtf8File(
  absolutePath: string,
  signal: AbortSignal,
): Promise<string> {
  return readFile(absolutePath, { encoding: 'utf8', signal });
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === 'AbortError';
}

function createDefaultDirectoryReadPreferences(): DirectoryReadPreferences {
  return {
    fileIndexing: createDefaultFileIndexingPreferences(),
    gitExecutablePath: '',
  };
}

/**
 * The `preferences` record of a desktop preferences file, or null when the
 * envelope is unusable (not JSON, an unreadable version, no `preferences`
 * record). Fields inside are not checked; each reader normalizes its own.
 */
export function readDesktopPreferencesRecord(
  raw: string,
): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return readPreferencesEnvelopeRecord(parsed);
}

/**
 * Mirrors desktop `normalizeParsedPreferencesFile`: the envelope decides the
 * selected file; fields inside it only normalize, never fall through.
 */
function selectPreferencesEnvelope(
  raw: string,
): DirectoryReadPreferences | null {
  const preferences = readDesktopPreferencesRecord(raw);
  if (!preferences) {
    return null;
  }
  const { fileIndexing, gitExecutablePath } = preferences;
  return {
    fileIndexing: normalizeFileIndexingPreferences(fileIndexing),
    gitExecutablePath:
      typeof gitExecutablePath === 'string' ? gitExecutablePath : '',
  };
}

/**
 * Read-only projection of desktop preference read selection for directory
 * policy. Desktop recovery (backup, restore and last-good writes) stays with
 * the desktop single writer; this never creates, repairs or caches anything.
 */
export function createDirectoryReadPreferenceSource(
  options: DirectoryReadPreferenceSourceOptions,
): DirectoryReadPreferenceSource {
  const { canonicalDataRoot, paths } = options;
  if (!canonicalDataRoot || !paths.isAbsolute(canonicalDataRoot)) {
    throw new TypeError(
      'Directory preferences require an absolute canonical data root.',
    );
  }
  const readText = options.readFile ?? readUtf8File;
  const primaryPath = paths.join(
    canonicalDataRoot,
    DIRECTORY_PRIMARY_PREFERENCES_FILE_NAME,
  );
  const lastGoodPath = paths.join(
    canonicalDataRoot,
    DIRECTORY_LAST_GOOD_PREFERENCES_FILE_NAME,
  );

  const readCandidate = async (
    absolutePath: string,
    signal: AbortSignal,
  ): Promise<DirectoryReadPreferences | null> => {
    signal.throwIfAborted();
    let raw: string;
    try {
      raw = await readText(absolutePath, signal);
    } catch (error) {
      // Cancellation is not an unreadable file and must not select defaults.
      signal.throwIfAborted();
      if (isAbortError(error)) {
        throw error;
      }
      return null;
    }
    signal.throwIfAborted();
    return selectPreferencesEnvelope(raw);
  };

  return {
    async read(signal): Promise<DirectoryReadPreferenceSnapshot> {
      // Each await can resume after an abort that landed past readCandidate's
      // own checks, so recheck before selecting, falling back or defaulting.
      const primary = await readCandidate(primaryPath, signal);
      signal.throwIfAborted();
      if (primary) {
        return { source: 'primary', preferences: primary };
      }
      const lastGood = await readCandidate(lastGoodPath, signal);
      signal.throwIfAborted();
      if (lastGood) {
        return { source: 'last-good', preferences: lastGood };
      }
      return {
        source: 'defaults',
        preferences: createDefaultDirectoryReadPreferences(),
      };
    },
  };
}
