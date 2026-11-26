import { createHash, randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  WorkerTerminalRecordOpenResultSchema,
  WorkerTerminalRecordEntrySchema,
  type WorkerTerminalRecordLegacyLayout,
  type WORKER_TERMINAL_RECORD_IMPORT_SOURCES,
} from '@canopy/protocol/canopy-core';
import type { PersistedTerminalEntry } from '@canopy/protocol/terminal';
import { damagedCopyPath, pruneDamagedCopiesSync } from '../../damaged-copies';
import { createDurableAtomicInstall } from '../../pipeline/store/atomic-install';
import {
  STORAGE_OWNERSHIP,
  StorageOutcomeUnknownError,
  assertAdmittedWriter,
} from '../../../storage';
import { isWorkerFile, readLegacyTerminalState } from './codec';
import {
  legacyTerminalStatePath,
  terminalRecordDir,
  terminalRecordProjectDir,
} from './paths';
import type { TerminalRecordPayloadState } from './ops';

export type TerminalRecordImportSource =
  (typeof WORKER_TERMINAL_RECORD_IMPORT_SOURCES)[number];

/** The worker plane's v2 record payload: membership, sessions, output, names. */
export type TerminalRecordPayload = TerminalRecordPayloadState;

/**
 * One worktree's terminal record (CAN-7051), written only by the daemon's
 * record authority. `generation` grows with each retirement of the scope;
 * `producerWatermarks` commit, with the payload, the last batch applied from
 * each producer run; `hostTerminals` are the daemon terminals that may still
 * be live, reconciled after a daemon death.
 */
export interface TerminalRecordEnvelope {
  version: 3;
  scope: { projectId: string; worktreeId: string };
  generation: number;
  incarnation: string | null;
  lifetimeIds?: string[];
  retiredLifetimeIds?: string[];
  /**
   * When this lifetime's record started (ms); absent in older records. Only a
   * known start can prove cutoff ordering when lifetime identity is unavailable.
   */
  startedAt?: number;
  lineage: string;
  revision: number;
  record: TerminalRecordPayload;
  producerWatermarks: Record<string, number>;
  /** The same escaped producer/run keys as watermarks; no deployed raw-run v3 writer. */
  runs: Record<string, { sealed?: { reason: string; at: number } }>;
  hostTerminals: string[];
  import: {
    from: TerminalRecordImportSource;
    sourceSha256: string | null;
    at: number;
    /**
     * The legacy state could not be read yet: this record holds only what
     * daemon terminals reported meanwhile, and its import is retried on the
     * next touch, this daemon run or a later one.
     */
    pending?: true;
  };
}

export interface TerminalRecordTombstone {
  /** Names alone cannot distinguish a retired artifact from its replacement. */
  cleanupFiles?: { name: string; identity: string | null }[];
  retiredLifetimeIds?: string[];
  /** Zero carries named coverage only; record generations start at one. */
  generation: number;
  namedOnly?: true;
  incarnation: string | null;
  retiredAt: number;
  /** Partial fence: no incarnation, timestamp order or artifact ownership proof. */
  damaged?: true;
}

type FenceFields = { generation?: number; retiredLifetimeIds?: string[] };

type TombstoneObservation =
  | { kind: 'absent' }
  | ({ kind: 'damaged' } & FenceFields)
  | { kind: 'valid'; image: TerminalRecordTombstone };

/** Publication evidence always names the immutable image attempted. */
export type TerminalRecordPublication<T> =
  | { state: 'unpublished'; error: unknown }
  | { state: 'published-unconfirmed'; image: T; error?: unknown }
  | { state: 'durable'; image: T };

export type TerminalRecordLoad =
  | {
      kind: 'record';
      envelope: TerminalRecordEnvelope;
      tombstone?: TerminalRecordTombstone;
    }
  | { kind: 'absent'; tombstone: TerminalRecordTombstone | null };

export interface TerminalRecordRepositoryOptions {
  readonly dataRoot: string;
  /** The host's directory flush, after each install's rename. */
  readonly flushDirectorySync: (directory: string) => void;
  readonly log?: (message: string, details: Record<string, unknown>) => void;
  readonly now?: () => number;
}

const RECORD_FILE = 'record.json';
const TOMBSTONE_FILE = 'tombstone.json';
const BACKUP_FILE = 'import-source.json';
const LEGACY_DAMAGED_FILE = 'legacy-terminal-state.json';
const FILE_MODE = 0o600;
const PREVIEW_CACHE_BYTES = 8 * 1024 * 1024;
const PREVIEW_CACHE_ENTRIES = 4;
const CLAIM = {
  namespace: 'terminal_record',
  writer: 'daemon',
  module: 'packages/core-runtime/src/node/terminal/record/repository.ts',
} as const;

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringMap(value: unknown): value is Record<string, string> {
  return (
    isRecordValue(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

// Reuse read contracts, not bounded producer inputs: stored legacy IDs and
// binding keys intentionally remain wider than layout.save/session.upsert.
const STORED_HEADER = WorkerTerminalRecordOpenResultSchema.pick({
  generation: true,
  lineage: true,
  revision: true,
  import: true,
  producerWatermarks: true,
}).strip();
const STORED_EXIT = WorkerTerminalRecordEntrySchema.pick({
  exitCode: true,
  signal: true,
}).strip();

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readFenceFields(parsed: Record<string, unknown>): FenceFields {
  const generation =
    WorkerTerminalRecordOpenResultSchema.shape.generation.safeParse(
      parsed.generation,
    );
  const ids = parsed.retiredLifetimeIds;
  return {
    ...(generation.success ? { generation: generation.data } : {}),
    ...(Array.isArray(ids) &&
    ids.every((id): id is string => typeof id === 'string')
      ? { retiredLifetimeIds: ids }
      : {}),
  };
}

export function isTerminalRecordEnvelope(
  value: unknown,
): value is TerminalRecordEnvelope {
  if (!isRecordValue(value) || value.version !== 3) return false;
  const { scope, record, runs, hostTerminals } = value;
  return (
    isRecordValue(scope) &&
    typeof scope.projectId === 'string' &&
    typeof scope.worktreeId === 'string' &&
    STORED_HEADER.safeParse(value).success &&
    (value.incarnation === null || typeof value.incarnation === 'string') &&
    [value.lifetimeIds, value.retiredLifetimeIds].every(
      (ids) =>
        ids === undefined ||
        (Array.isArray(ids) && ids.every((id) => typeof id === 'string')),
    ) &&
    (value.startedAt === undefined || isTimestamp(value.startedAt)) &&
    isRecordValue(record) &&
    (record.truncatedHistoryIds === undefined ||
      (Array.isArray(record.truncatedHistoryIds) &&
        record.truncatedHistoryIds.every((id) => typeof id === 'string'))) &&
    // The payload is main's v2 worker file's: colliding keys damage it.
    isWorkerFile({ ...record, version: 2, lineage: value.lineage }) &&
    Array.isArray(record.terminals) &&
    record.terminals.every(
      (entry) =>
        isRecordValue(entry) &&
        isRecordValue(entry.session) &&
        entry.session.projectId === scope.projectId &&
        entry.session.worktreeId === scope.worktreeId &&
        STORED_EXIT.safeParse(entry).success,
    ) &&
    isStringMap(record.terminalCustomNames) &&
    isRecordValue(value.producerWatermarks) &&
    isRecordValue(runs) &&
    Object.values(runs).every(
      (run) =>
        isRecordValue(run) &&
        (run.sealed === undefined ||
          (isRecordValue(run.sealed) &&
            typeof run.sealed.reason === 'string' &&
            isTimestamp(run.sealed.at))),
    ) &&
    Array.isArray(hostTerminals) &&
    hostTerminals.every((id) => typeof id === 'string') &&
    isRecordValue(value.import) &&
    isTimestamp(value.import.at) &&
    (value.import.pending === undefined || value.import.pending === true)
  );
}

function isTombstone(value: unknown): value is TerminalRecordTombstone {
  return (
    isRecordValue(value) &&
    (value.cleanupFiles === undefined ||
      (Array.isArray(value.cleanupFiles) &&
        value.cleanupFiles.every(
          (file) =>
            isRecordValue(file) &&
            typeof file.name === 'string' &&
            file.name.length > 0 &&
            file.name !== '.' &&
            file.name !== '..' &&
            !file.name.includes('/') &&
            !file.name.includes('\\') &&
            (file.identity === null || typeof file.identity === 'string'),
        ))) &&
    (value.retiredLifetimeIds === undefined ||
      (Array.isArray(value.retiredLifetimeIds) &&
        value.retiredLifetimeIds.every((id) => typeof id === 'string'))) &&
    ((value.namedOnly === true &&
      value.generation === 0 &&
      value.incarnation === null &&
      value.retiredAt === 0 &&
      value.damaged === true) ||
      (value.namedOnly === undefined &&
        WorkerTerminalRecordOpenResultSchema.shape.generation.safeParse(
          value.generation,
        ).success)) &&
    isTimestamp(value.retiredAt) &&
    (value.damaged === undefined || value.damaged === true) &&
    (value.incarnation === null || typeof value.incarnation === 'string')
  );
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const code: unknown = Reflect.get(error, 'code');
  return typeof code === 'string' ? code : undefined;
}

function readIfPresent(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

function artifactIdentity(path: string): string | null {
  try {
    const stat = lstatSync(path, { bigint: true });
    // A directory's identity cannot qualify the contents of its descendants.
    if (!stat.isFile()) return null;
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

function previewIdentity(path: string): string | null {
  try {
    return artifactIdentity(path);
  } catch {
    // Cache admission must not hide bytes that remain readable.
    return null;
  }
}

/** The legacy state exists but could not be read; its import is retried. */
export class TerminalLegacyUnreadableError extends Error {
  public constructor(public readonly code: string | undefined) {
    super('The legacy terminal state could not be read.');
    this.name = 'TerminalLegacyUnreadableError';
  }
}

export interface TerminalRecordImportInput {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly layout: WorkerTerminalRecordLegacyLayout;
  readonly incarnation: string | null;
  readonly generation: number;
}

interface LegacyPreview {
  terminals: PersistedTerminalEntry[];
  sourceSha256: string | null;
}

/**
 * The record files of every worktree (CAN-7051): atomic installs through the
 * storage admission of `terminal_record`, tombstones for retired scopes,
 * the verified backup of what was imported, and set-aside damaged records.
 * It reads main's legacy file at import only, and never writes or deletes it.
 */
export class TerminalRecordRepository {
  private readonly install: ReturnType<typeof createDurableAtomicInstall>;
  private readonly durableDirectories = new Set<string>();
  private readonly previews = new Map<
    string,
    { identity: string; bytes: number; preview: LegacyPreview }
  >();

  public constructor(
    private readonly options: TerminalRecordRepositoryOptions,
  ) {
    this.install = createDurableAtomicInstall(options.flushDirectorySync);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private log(message: string, details: Record<string, unknown>): void {
    this.options.log?.(message, details);
  }

  private dir(projectId: string, worktreeId: string): string {
    return terminalRecordDir(this.options.dataRoot, projectId, worktreeId);
  }

  private write(directory: string, file: string, value: unknown): void {
    // Admitted before anything is created, the directory included.
    assertAdmittedWriter(
      CLAIM.namespace,
      CLAIM.writer,
      CLAIM.module,
      STORAGE_OWNERSHIP,
    );
    const created = mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (created !== undefined || !this.durableDirectories.has(directory)) {
      // The cached proof is for the ancestor entries naming this directory: a
      // recreation voids it, and it returns only once every ancestor flush succeeds.
      this.durableDirectories.delete(directory);
      const root = resolve(this.options.dataRoot);
      for (let child = resolve(directory); ; child = dirname(child)) {
        this.options.flushDirectorySync(dirname(child));
        if (child === root) break;
      }
      this.durableDirectories.add(directory);
    }
    this.install(
      join(directory, file),
      JSON.stringify(value),
      CLAIM,
      FILE_MODE,
    );
  }

  /** Reads are observational; only a write-authorized caller may recover. */
  public load(
    projectId: string,
    worktreeId: string,
    access: 'read' | 'recover' = 'read',
  ): TerminalRecordLoad {
    const directory = this.dir(projectId, worktreeId);
    const recordPath = join(directory, RECORD_FILE);
    // Read first: a record its retirement could not remove stays retired.
    const observation = this.readTombstone(directory);
    const tombstone = observation.kind === 'valid' ? observation.image : null;
    const damagedGeneration =
      observation.kind === 'damaged' ? observation.generation : undefined;
    let recoveredFence: TerminalRecordTombstone | undefined;
    const bytes = readIfPresent(recordPath);
    if (bytes !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(bytes.toString('utf8'));
      } catch {
        parsed = undefined;
      }
      const envelope =
        isTerminalRecordEnvelope(parsed) &&
        parsed.scope.projectId === projectId &&
        parsed.scope.worktreeId === worktreeId
          ? parsed
          : null;
      // An unreadable fence cannot hide a matching record. A parseable
      // generation still fences predecessors even when its timestamp is bad.
      if (
        envelope !== null &&
        (damagedGeneration === undefined ||
          envelope.generation > damagedGeneration) &&
        (tombstone === null || envelope.generation > tombstone.generation)
      ) {
        const retiredIds =
          observation.kind === 'damaged'
            ? observation.retiredLifetimeIds
            : tombstone?.retiredLifetimeIds;
        return {
          kind: 'record',
          envelope: retiredIds?.length
            ? {
                ...envelope,
                retiredLifetimeIds: Array.from(
                  new Set([
                    ...(envelope.retiredLifetimeIds ?? []),
                    ...retiredIds,
                  ]),
                ),
              }
            : envelope,
          ...(tombstone ? { tombstone } : {}),
        };
      }
      if (envelope !== null) {
        // Visibility is not a durable retirement receipt. Leave physical cleanup
        // to the scope owner after it confirms the fence and qualifies artifacts.
        return {
          kind: 'absent',
          tombstone:
            tombstone ?? this.recoverDamagedTombstone(directory, observation),
        };
      }
      if (
        isRecordValue(parsed) &&
        isRecordValue(parsed.scope) &&
        parsed.scope.projectId === projectId &&
        parsed.scope.worktreeId === worktreeId
      ) {
        const fields = readFenceFields(parsed);
        if (
          fields.generation !== undefined ||
          fields.retiredLifetimeIds?.length
        ) {
          const previous =
            tombstone ??
            (observation.kind === 'damaged'
              ? this.recoverDamagedTombstone(directory, observation)
              : null);
          const generation = Math.max(
            previous?.generation ?? 0,
            // Only validated names-only evidence makes an unknown generation
            // non-fencing; otherwise retain the damaged-record fence contract.
            fields.generation ?? (tombstone?.namedOnly ? 0 : 1),
          );
          const cleanupFiles = tombstone?.cleanupFiles?.filter(
            (file) => file.identity !== null,
          );
          recoveredFence = {
            generation,
            ...(generation === 0 ? { namedOnly: true as const } : {}),
            incarnation: null,
            retiredAt: 0,
            damaged: true,
            ...(cleanupFiles?.length ? { cleanupFiles } : {}),
            retiredLifetimeIds: Array.from(
              new Set([
                ...(previous?.retiredLifetimeIds ?? []),
                ...(fields.retiredLifetimeIds ?? []),
              ]),
            ),
          };
        }
      }
      if (access === 'recover') {
        assertAdmittedWriter(
          CLAIM.namespace,
          CLAIM.writer,
          CLAIM.module,
          STORAGE_OWNERSHIP,
        );
        // Persist only fences before quarantine can remove their source.
        // Reads use the same projection without acquiring recovery rights.
        if (recoveredFence)
          this.write(directory, TOMBSTONE_FILE, recoveredFence);
        // Kept beside it; the requested scope starts from its own fence.
        const aside = damagedCopyPath(recordPath, this.now());
        try {
          renameSync(recordPath, aside);
          pruneDamagedCopiesSync(recordPath);
        } catch (error) {
          this.log('Could not set aside a damaged terminal record', {
            code: errorCode(error),
          });
          // Never overwrite the only recovery image when quarantine fails.
          throw error;
        }
      }
      this.log('Found a damaged or foreign-scope terminal record', {
        projectId,
        worktreeId,
      });
    }
    return {
      kind: 'absent',
      tombstone:
        recoveredFence ??
        (observation.kind === 'damaged'
          ? this.recoverDamagedTombstone(directory, observation)
          : tombstone),
    };
  }

  private readTombstone(directory: string): TombstoneObservation {
    const path = join(directory, TOMBSTONE_FILE);
    const bytes = readIfPresent(path);
    if (bytes === null) return { kind: 'absent' };
    try {
      const parsed: unknown = JSON.parse(bytes.toString('utf8'));
      if (isTombstone(parsed)) return { kind: 'valid', image: parsed };
      if (isRecordValue(parsed)) {
        return {
          kind: 'damaged',
          ...readFenceFields(parsed),
        };
      }
    } catch {
      // Damaged: below.
    }
    return { kind: 'damaged' };
  }

  private recoverDamagedTombstone(
    directory: string,
    observation: TombstoneObservation,
  ): TerminalRecordTombstone {
    // A damaged tombstone still means the scope was retired. Its write time
    // is a generation floor every load agrees on, above any generation
    // issued before it, so a late writer of the retired record stays stale.
    // Unavailable metadata leaves recovery pending, never a generation-1 fence.
    const floor = Math.max(
      observation.kind === 'damaged' ? (observation.generation ?? 1) : 1,
      Math.floor(statSync(join(directory, TOMBSTONE_FILE)).mtimeMs),
    );
    return {
      generation: floor,
      incarnation: null,
      retiredAt: 0,
      damaged: true,
      // Partial fields never prove timestamp ordering or cleanup ownership.
      ...(observation.kind === 'damaged' && observation.retiredLifetimeIds
        ? { retiredLifetimeIds: observation.retiredLifetimeIds }
        : {}),
    };
  }

  /** Installs the record; throws when it may not or could not be written. */
  public save(envelope: TerminalRecordEnvelope): void {
    this.write(
      this.dir(envelope.scope.projectId, envelope.scope.worktreeId),
      RECORD_FILE,
      envelope,
    );
  }

  public publishRecord(
    envelope: TerminalRecordEnvelope,
  ): TerminalRecordPublication<TerminalRecordEnvelope> {
    const image = structuredClone(envelope);
    try {
      this.save(image);
      return { state: 'durable', image };
    } catch (error) {
      return error instanceof StorageOutcomeUnknownError
        ? { state: 'published-unconfirmed', image, error }
        : { state: 'unpublished', error };
    }
  }

  /** Visibility after restart is not durability; confirm before acknowledging. */
  public confirmDurability(projectId: string, worktreeId: string): void {
    this.options.flushDirectorySync(this.dir(projectId, worktreeId));
  }

  /** An empty record of `generation`, as a retired or new scope starts. */
  public empty(
    input: Omit<TerminalRecordImportInput, 'layout'>,
    from: TerminalRecordImportSource,
  ): TerminalRecordEnvelope {
    return {
      version: 3,
      scope: { projectId: input.projectId, worktreeId: input.worktreeId },
      generation: input.generation,
      incarnation: input.incarnation,
      startedAt: this.now(),
      lineage: randomUUID(),
      revision: 0,
      record: { bindings: [], terminals: [], terminalCustomNames: {} },
      producerWatermarks: {},
      runs: {},
      hostTerminals: [],
      import: { from, sourceSha256: null, at: this.now() },
    };
  }

  /** A legacy history preview: no backup, import decision, repair or install. */
  public previewLegacy(
    input: Pick<
      TerminalRecordImportInput,
      'projectId' | 'worktreeId' | 'layout'
    >,
  ): LegacyPreview {
    const path = legacyTerminalStatePath(
      this.options.dataRoot,
      input.layout,
      input.projectId,
      input.worktreeId,
    );
    const identity = previewIdentity(path);
    const cached = this.previews.get(path);
    this.previews.delete(path);
    if (identity !== null && cached?.identity === identity) {
      this.previews.set(path, cached);
      return structuredClone(cached.preview);
    }
    let bytes: Buffer | null;
    try {
      bytes = readIfPresent(path);
    } catch (error) {
      this.log(
        'Could not preview legacy terminal history; leaving it for retry',
        {
          code: errorCode(error),
        },
      );
      return { terminals: [], sourceSha256: null };
    }
    const legacy = readLegacyTerminalState(
      bytes,
      input.projectId,
      input.worktreeId,
    );
    const preview =
      legacy.kind === 'v1' || legacy.kind === 'v2'
        ? {
            terminals: legacy.records.worker.terminals,
            sourceSha256: legacy.sha256,
          }
        : { terminals: [], sourceSha256: null };
    // Pages reuse decoded bytes, not an import decision. Stat identity includes
    // nanosecond ctime; replaced/edited sources invalidate the content epoch.
    if (
      identity !== null &&
      bytes !== null &&
      bytes.length <= PREVIEW_CACHE_BYTES &&
      previewIdentity(path) === identity
    ) {
      this.previews.set(path, { identity, bytes: bytes.length, preview });
      let size = Array.from(this.previews.values()).reduce(
        (total, entry) => total + entry.bytes,
        0,
      );
      for (const [key, entry] of this.previews) {
        if (
          this.previews.size <= PREVIEW_CACHE_ENTRIES &&
          size <= PREVIEW_CACHE_BYTES
        )
          break;
        this.previews.delete(key);
        size -= entry.bytes;
      }
    }
    return structuredClone(preview);
  }

  /**
   * The record a scope starts from on its first write-authorized touch (CAN-7051): main's
   * legacy state as it last wrote it, with a verified backup of its bytes.
   * A damaged legacy file is copied beside the record and imported empty; a
   * newer or fenced one is imported empty. One that cannot be read throws
   * `TerminalLegacyUnreadableError`. Not installed: the caller does.
   */
  public importLegacy(
    input: TerminalRecordImportInput,
  ): TerminalRecordEnvelope {
    const legacyPath = legacyTerminalStatePath(
      this.options.dataRoot,
      input.layout,
      input.projectId,
      input.worktreeId,
    );
    let bytes: Buffer | null;
    try {
      bytes = readIfPresent(legacyPath);
    } catch (error) {
      // Unreadable now, not absent: nothing is imported, so the caller
      // retries rather than install an empty record over it.
      this.log('Could not read legacy terminal state; retrying its import', {
        code: errorCode(error),
      });
      throw new TerminalLegacyUnreadableError(errorCode(error));
    }
    const legacy = readLegacyTerminalState(
      bytes,
      input.projectId,
      input.worktreeId,
    );
    const directory = this.dir(input.projectId, input.worktreeId);
    switch (legacy.kind) {
      case 'absent':
        return this.empty(input, 'none');
      case 'newer':
        this.log('Legacy terminal state is newer; importing empty', {});
        return this.empty(input, 'newer');
      case 'fenced':
        // The record was lost after an import: nothing older is trusted.
        this.log('Terminal record missing behind its fence; starting empty', {
          projectId: input.projectId,
        });
        return this.empty(input, 'fenced');
      case 'damaged': {
        const copy = { bytes: legacy.bytes.toString('base64') };
        const copies = this.recoveryCopiesOf(directory, copy);
        try {
          // A retry reinstalls its earlier attempt's copy rather than add one.
          this.write(
            directory,
            copies[0] ??
              basename(
                damagedCopyPath(
                  join(directory, LEGACY_DAMAGED_FILE),
                  this.now(),
                ),
              ),
            copy,
          );
        } catch (error) {
          this.log('Could not keep damaged legacy terminal state', {
            code: errorCode(error),
          });
          throw error;
        }
        this.removeRecoveryCopies(directory, copies.slice(1));
        return this.empty(input, 'damaged');
      }
      case 'v1':
      case 'v2': {
        const backupPath = join(directory, BACKUP_FILE);
        const backup = {
          sha256: legacy.sha256,
          bytes: legacy.bytes.toString('base64'),
          from: legacy.kind,
        };
        const existing = readIfPresent(backupPath);
        // A later import cannot prove ownership of a differing earlier
        // backup, so it is set aside; an identical one (a retry's own) is
        // reinstalled in place, adding no copy.
        if (
          existing !== null &&
          !existing.equals(Buffer.from(JSON.stringify(backup)))
        ) {
          assertAdmittedWriter(
            CLAIM.namespace,
            CLAIM.writer,
            CLAIM.module,
            STORAGE_OWNERSHIP,
          );
          renameSync(
            backupPath,
            damagedCopyPath(join(directory, LEGACY_DAMAGED_FILE), this.now()),
          );
          this.options.flushDirectorySync(directory);
        }
        this.write(directory, BACKUP_FILE, backup);
        this.removeRecoveryCopies(
          directory,
          this.recoveryCopiesOf(directory, backup),
        );
        const { worker } = legacy.records;
        return {
          ...this.empty(input, legacy.kind),
          lineage: worker.lineage,
          record: {
            bindings: worker.bindings,
            terminals: worker.terminals,
            terminalCustomNames: Object.fromEntries(
              Object.entries(worker.terminalCustomNames ?? {}).filter(
                ([, name]) => typeof name === 'string',
              ),
            ),
          },
          import: {
            from: legacy.kind,
            sourceSha256: legacy.sha256,
            at: this.now(),
          },
        };
      }
    }
  }

  /** The legacy recovery copies holding exactly `value`, by name. */
  private recoveryCopiesOf(directory: string, value: unknown): string[] {
    const content = Buffer.from(JSON.stringify(value));
    const prefix = `${LEGACY_DAMAGED_FILE}.damaged-`;
    // An entry that cannot be read is not a match; it never stops a retry.
    const matches = (name: string): boolean => {
      if (!name.startsWith(prefix)) return false;
      const path = join(directory, name);
      try {
        const stat = lstatSync(path);
        return (
          stat.isFile() &&
          stat.size === content.length &&
          readFileSync(path).equals(content)
        );
      } catch {
        return false;
      }
    };
    try {
      return readdirSync(directory).filter(matches).sort();
    } catch (error) {
      if (errorCode(error) !== 'ENOENT')
        this.log('Could not list terminal recovery copies', {
          code: errorCode(error),
        });
      return [];
    }
  }

  /** Best effort, once the content they duplicate is durable elsewhere. */
  private removeRecoveryCopies(directory: string, names: string[]): void {
    if (names.length === 0) return;
    try {
      assertAdmittedWriter(
        CLAIM.namespace,
        CLAIM.writer,
        CLAIM.module,
        STORAGE_OWNERSHIP,
      );
      for (const name of names) rmSync(join(directory, name), { force: true });
      this.options.flushDirectorySync(directory);
    } catch (error) {
      this.log('Could not remove duplicate terminal recovery copies', {
        code: errorCode(error),
      });
    }
  }

  /**
   * Publishes coverage and removes only identity-qualified artifacts. Positive
   * generations prevent legacy reimport; names-only coverage fences listed IDs.
   * Publication and qualified cleanup are separate obligations. The observer
   * retains the exact fence even if confirmation or cleanup fails.
   */
  public retire(
    projectId: string,
    worktreeId: string,
    tombstone: TerminalRecordTombstone,
    onPublished?: (
      publication: Exclude<
        TerminalRecordPublication<TerminalRecordTombstone>,
        { state: 'unpublished' }
      >,
    ) => void,
  ): void {
    const directory = this.dir(projectId, worktreeId);
    let cleanupFiles = tombstone.cleanupFiles;
    if (cleanupFiles === undefined) {
      try {
        cleanupFiles = readdirSync(directory).map((name) => ({
          name,
          identity: artifactIdentity(join(directory, name)),
        }));
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
        cleanupFiles = [];
      }
    }
    const previous = this.readTombstone(directory);
    const inherited = previous.kind === 'valid' ? previous.image : undefined;
    // Cleanup identities belong to the tombstone, not to the latest selector.
    const pending = {
      ...tombstone,
      retiredLifetimeIds: Array.from(
        new Set([
          ...(inherited?.retiredLifetimeIds ?? []),
          ...(tombstone.retiredLifetimeIds ?? []),
        ]),
      ),
      cleanupFiles: [
        ...(inherited?.cleanupFiles ?? []),
        ...cleanupFiles,
      ].filter(
        (file, index, files) =>
          files.findIndex(
            (candidate) =>
              candidate.name === file.name &&
              candidate.identity === file.identity,
          ) === index,
      ),
    };
    try {
      this.write(directory, TOMBSTONE_FILE, pending);
    } catch (error) {
      // A visible fence is forward-only even if its directory flush failed.
      // Earlier failures must leave live buffered reports and installs intact.
      if (error instanceof StorageOutcomeUnknownError)
        onPublished?.({
          state: 'published-unconfirmed',
          image: pending,
          error,
        });
      throw error;
    }
    onPublished?.({ state: 'durable', image: pending });
    this.cleanupRetirement(directory, pending);
  }

  /**
   * Worktrees with a valid record directory under a project. Read-only: a
   * project-wide retirement re-lists them on every attempt and lets its
   * cutoff, not this list, keep a later worktree out.
   */
  public worktreesOf(projectId: string): string[] {
    try {
      return readdirSync(
        terminalRecordProjectDir(this.options.dataRoot, projectId),
        { withFileTypes: true },
      )
        .filter((entry) => {
          if (!entry.isDirectory()) return false;
          try {
            terminalRecordDir(this.options.dataRoot, projectId, entry.name);
            return true;
          } catch {
            return false;
          }
        })
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    }
  }

  /**
   * Completes an inherited retirement without removing the successor record.
   * `sync` forces the directory sync an earlier failed cleanup still owes.
   */
  public retryRetirement(
    projectId: string,
    worktreeId: string,
    sync = false,
  ): void {
    const directory = this.dir(projectId, worktreeId);
    const observation = this.readTombstone(directory);
    if (observation.kind === 'damaged') {
      this.log('Retaining unqualified terminal retirement artifacts', {
        projectId,
        worktreeId,
      });
      return;
    }
    if (observation.kind === 'valid') {
      const tombstone = observation.image;
      // Legacy/damaged tombstones cannot prove ownership of successor files.
      // Prefer retaining ambiguous data to deleting the successor's history.
      if (tombstone.cleanupFiles === undefined)
        this.log('Retaining unqualified terminal retirement artifacts', {
          projectId,
          worktreeId,
        });
      this.cleanupRetirement(directory, tombstone, sync);
    }
  }

  private cleanupRetirement(
    directory: string,
    tombstone: TerminalRecordTombstone,
    sync = false,
  ): void {
    assertAdmittedWriter(
      CLAIM.namespace,
      CLAIM.writer,
      CLAIM.module,
      STORAGE_OWNERSHIP,
    );
    // The scope owns this directory: recovery and interrupted-install copies
    // contain terminal content too. A retry removes only the old artifacts.
    let removed = false;
    for (const file of tombstone.cleanupFiles ?? []) {
      if (file.name === TOMBSTONE_FILE) continue;
      const path = join(directory, file.name);
      if (file.identity === null || artifactIdentity(path) !== file.identity)
        continue;
      rmSync(path, { force: true, recursive: true });
      removed = true;
    }
    // Nothing removed: the fence's own sync already covers this directory.
    if (removed || sync) this.options.flushDirectorySync(directory);
  }

  /**
   * The Phase 0B tested restore: the imported legacy bytes, verified against
   * their SHA-256, and only their matching imported record removed. The
   * caller (main's own writer) reinstalls the bytes at the legacy path.
   */
  public takeLegacyBackup(
    projectId: string,
    worktreeId: string,
  ): Buffer | null {
    const directory = this.dir(projectId, worktreeId);
    const backup = readIfPresent(join(directory, BACKUP_FILE));
    if (backup === null) return null;
    const parsed: unknown = JSON.parse(backup.toString('utf8'));
    if (
      !isRecordValue(parsed) ||
      typeof parsed.bytes !== 'string' ||
      typeof parsed.sha256 !== 'string'
    )
      throw new Error('The terminal record backup is damaged.');
    const bytes = Buffer.from(parsed.bytes, 'base64');
    if (createHash('sha256').update(bytes).digest('hex') !== parsed.sha256)
      throw new Error('The terminal record backup does not match its hash.');
    const current = readIfPresent(join(directory, RECORD_FILE));
    if (current !== null) {
      let envelope: unknown;
      try {
        envelope = JSON.parse(current.toString('utf8'));
      } catch {
        return null;
      }
      if (
        !isTerminalRecordEnvelope(envelope) ||
        envelope.scope.projectId !== projectId ||
        envelope.scope.worktreeId !== worktreeId ||
        envelope.import.pending ||
        envelope.import.sourceSha256 !== parsed.sha256 ||
        envelope.import.from !== parsed.from
      )
        return null;
    }
    rmSync(join(directory, RECORD_FILE), { force: true });
    return bytes;
  }
}
