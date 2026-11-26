import { isStorageOutcomeUnknownError } from '../../../storage';

/** The file-identity facts a read compares to notice a replaced file. */
export interface PipelineLocalMetadataFileStat {
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

/**
 * Where a host keeps the pipeline local metadata file and how it writes it.
 * The host owns the file's path and its atomic, durable install.
 */
export interface PipelineLocalMetadataEnvironment {
  /** Where the file is now; a parsed copy is reused only for the same one. */
  readonly location: () => string;
  /** The file's identity; throws when it is missing or unreadable. */
  readonly stat: () => PipelineLocalMetadataFileStat;
  /** The file's text; throws with `code: 'ENOENT'` when it is missing. */
  readonly readText: () => string;
  /**
   * Installs the whole file atomically. A thrown storage outcome-unknown
   * error means the file was installed but its folder flush failed.
   */
  readonly install: (data: string) => void;
  readonly warn: (message: string) => void;
}

/** How a host reads entries it keeps and names a user pipeline's entry. */
export interface PipelineLocalMetadataCodec<Entry extends object> {
  /** A raw entry as the host trusts it; `{}` when nothing is usable. */
  readonly normalizeEntry: (value: unknown) => Entry;
  /** The entry key of a user pipeline. */
  readonly userPipelineKey: (pipelineId: string) => string;
}

export interface PipelineLocalMetadataFile<Entry extends object> {
  version: 1;
  entries: Record<string, Entry>;
  /** The file exists but can't be read; it is never overwritten. */
  unreadable?: true;
}

/**
 * How a write ended. Only `written` is a durable save: `unflushed` installed
 * the file but couldn't flush its folder, so it may not survive a crash.
 */
export type PipelineLocalMetadataWriteOutcome =
  | 'written'
  | 'unreadable'
  | 'failed'
  | 'unflushed';

/** The pipeline local metadata file over a host's environment (CAN-5092). */
export interface PipelineLocalMetadataStore<Entry extends object> {
  /** The file as parsed, or empty and unreadable when it can't be read. */
  readonly read: () => PipelineLocalMetadataFile<Entry>;
  /**
   * Writes the file without its empty entries and reports the write outcome.
   * An unreadable file is left unchanged, and a failed write is logged.
   */
  readonly write: (
    file: PipelineLocalMetadataFile<Entry>,
  ) => PipelineLocalMetadataWriteOutcome;
  /** Whether stored entries can be read; a missing file counts as readable. */
  readonly isReadable: () => boolean;
  /** A synchronous read-modify-write of one user pipeline's entry. */
  readonly updateUserPipeline: (
    pipelineId: string,
    update: (entry: Entry) => Entry,
  ) => void;
  /**
   * The same read-modify-write, for a caller that must not proceed on a
   * save it can't show: it reports how the write ended (CAN-7507).
   */
  readonly updateUserPipelineReported: (
    pipelineId: string,
    update: (entry: Entry) => Entry,
  ) => PipelineLocalMetadataWriteOutcome;
  /** Removes a user pipeline's entry; a missing one writes nothing. */
  readonly deleteUserPipeline: (pipelineId: string) => void;
  readonly userPipelineKey: (pipelineId: string) => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function statKey(stat: PipelineLocalMetadataFileStat): string {
  return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined;
}

/**
 * The pipeline local metadata file's read, write and recovery policy, over
 * a host's environment and entry codec. Its one writer replaces the file
 * atomically on every write and refreshes the parsed copy; the stat key only
 * lets a read notice a file replaced some other way.
 */
export function createPipelineLocalMetadataStore<Entry extends object>(
  environment: PipelineLocalMetadataEnvironment,
  codec: PipelineLocalMetadataCodec<Entry>,
): PipelineLocalMetadataStore<Entry> {
  let cached:
    | {
        readonly location: string;
        readonly key: string;
        readonly file: PipelineLocalMetadataFile<Entry>;
      }
    | undefined;

  const copyOf = (
    file: PipelineLocalMetadataFile<Entry>,
  ): PipelineLocalMetadataFile<Entry> => ({
    ...file,
    entries: { ...file.entries },
  });

  const remember = (
    location: string,
    file: PipelineLocalMetadataFile<Entry>,
  ): void => {
    try {
      cached = {
        location,
        key: statKey(environment.stat()),
        file: copyOf(file),
      };
    } catch {
      cached = undefined;
    }
  };

  const parse = (): PipelineLocalMetadataFile<Entry> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(environment.readText());
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { version: 1, entries: {} };
      environment.warn('Failed to parse metadata file; using empty defaults.');
      return { version: 1, entries: {}, unreadable: true };
    }
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      !isRecord(parsed.entries)
    ) {
      environment.warn(
        'Unsupported metadata file version or shape; using empty defaults.',
      );
      return { version: 1, entries: {}, unreadable: true };
    }
    const entries: Record<string, Entry> = {};
    for (const [key, raw] of Object.entries(parsed.entries)) {
      const entry = codec.normalizeEntry(raw);
      if (Object.keys(entry).length > 0) entries[key] = entry;
    }
    return { version: 1, entries };
  };

  const read = (): PipelineLocalMetadataFile<Entry> => {
    const location = environment.location();
    try {
      const key = statKey(environment.stat());
      if (cached?.location === location && cached.key === key)
        return copyOf(cached.file);
    } catch {
      // Missing or unreadable; parsing below reports which.
    }
    const file = parse();
    // Only a parsed file is kept; a failed read is retried on the next call.
    if (file.unreadable) cached = undefined;
    else remember(location, file);
    return file;
  };

  const install = (
    file: PipelineLocalMetadataFile<Entry>,
  ): PipelineLocalMetadataWriteOutcome => {
    // Rewriting a file that can't be read would drop every entry it holds.
    if (file.unreadable) {
      environment.warn('Metadata file is unreadable; leaving it unchanged.');
      return 'unreadable';
    }
    const entries: Record<string, Entry> = {};
    for (const [key, entry] of Object.entries(file.entries)) {
      if (Object.keys(entry).length > 0) entries[key] = entry;
    }
    const location = environment.location();
    try {
      environment.install(
        `${JSON.stringify({ version: 1, entries }, null, 2)}\n`,
      );
      remember(location, { version: 1, entries });
      return 'written';
    } catch (error) {
      if (isStorageOutcomeUnknownError(error)) {
        cached = undefined;
        environment.warn(
          'Metadata file installed, but its folder flush failed.',
        );
        return 'unflushed';
      }
      environment.warn(
        `Failed to write metadata file: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 'failed';
    }
  };

  const updateUserPipelineReported = (
    pipelineId: string,
    update: (entry: Entry) => Entry,
  ): PipelineLocalMetadataWriteOutcome => {
    const file = read();
    const key = codec.userPipelineKey(pipelineId);
    file.entries[key] = update({ ...file.entries[key] });
    return install(file);
  };

  return {
    read,
    write: install,
    isReadable: () => read().unreadable !== true,
    updateUserPipeline: (pipelineId, update) => {
      updateUserPipelineReported(pipelineId, update);
    },
    updateUserPipelineReported,
    deleteUserPipeline: (pipelineId) => {
      const file = read();
      const key = codec.userPipelineKey(pipelineId);
      if (!file.entries[key]) return;
      delete file.entries[key];
      install(file);
    },
    userPipelineKey: codec.userPipelineKey,
  };
}
