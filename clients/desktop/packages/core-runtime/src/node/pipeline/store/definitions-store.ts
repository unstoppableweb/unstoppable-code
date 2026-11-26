import { createHash, randomUUID } from 'node:crypto';
import { statSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as yaml from 'js-yaml';
import { getTriggerTypes } from '@canopy/pipeline-interop/document';
import type {
  Pipeline,
  PipelineExecutionScope,
  PipelineTriggerType,
} from '@canopy/pipeline-interop/document';
import { normalizePipeline } from '@canopy/pipeline-interop/normalize-pipeline';
import { parsePipelineText } from '@canopy/pipeline-interop/parse-pipeline';
import { normalizePipelineScopes } from '@canopy/pipeline-interop/scope';
import { serializePipelineDocument } from '@canopy/pipeline-interop/serialize-pipeline';
import type {
  IPCResult,
  PipelineData,
  PipelineIndex,
  PipelineSaveInput,
} from '@canopy/pipeline-interop/stored-pipelines';
import type {
  CuratedPipelineOrigin,
  PipelineIndexEntry,
  PipelineInfo,
} from '@canopy/protocol/pipelines';
import { isCuratedCatalogKey } from '@canopy/protocol/plugin-catalog';
import {
  parseShareRemoteMetadata,
  type ShareRemoteMetadata,
} from '@canopy/protocol/sharing';
import {
  assertAdmittedWriter,
  isStorageOutcomeUnknownError,
  type StorageOwnershipRow,
  type StorageTransitionOwner,
  type StorageWriterPrincipal,
} from '../../../storage';
import {
  decideRowWrite,
  parseOwnerFlipRecord,
} from '../../../storage/owner-records';
import { damagedCopyPath } from '../../damaged-copies';

/** A write's admission claim: the namespace, the writer and its module (CAN-5092). */
export interface StoredPipelineInstallClaim {
  readonly namespace: 'pipeline_definitions';
  readonly writer: StorageWriterPrincipal;
  readonly module: string;
  readonly ownership?: readonly StorageOwnershipRow[];
}

export interface StoredPipelineLockOptions {
  readonly maxWaitMs: number;
  readonly pollMs?: number;
  readonly timeoutMessage: string;
}

/** The owner lock both hosts take over the same lock files (core-platform's). */
export interface StoredPipelineLock {
  ensurePrivateLockDirectorySync(directory: string): void;
  withOwnerLockFileSync<T>(
    lockPath: string,
    operation: () => T,
    options: StoredPipelineLockOptions,
  ): T;
}

/**
 * What a host supplies to the portable definitions store (CAN-5092): its
 * folders, its writer lock, and every write into the user definitions
 * folder, so the store reads no process-global root, makes no platform
 * decision and writes nothing itself.
 */
export interface PipelineDefinitionStoreEnvironment {
  /** The user definitions folder, `<data>/pipelines`. */
  userPipelinesDir(): string;
  /** The user definitions index, `<data>/pipelines/index.json`. */
  userPipelineIndexPath(): string;
  /** The bundled definitions folder, read only. */
  bundledPipelinesDir(): string;
  /**
   * Runs `operation` holding the cross-process writer lock,
   * `<data>/locks/pipeline-definitions/writer.lock`, the one every host
   * takes; throws `options.timeoutMessage` when it stays held.
   */
  withWriterLock<T>(operation: () => T, options: StoredPipelineLockOptions): T;
  /**
   * Installs `data` as `fileName` in the user definitions folder,
   * atomically and durably, admitted by `claim`. An installed file whose
   * folder flush failed rejects with a storage outcome-unknown error.
   */
  installUserFile(
    fileName: string,
    data: string,
    claim: StoredPipelineInstallClaim,
  ): void;
  /** Removes `fileName` from the user definitions folder. */
  removeUserFile(fileName: string): void;
  /** Flushes the user definitions folder. */
  flushUserDirectory(): void;
  /** Creates the user definitions folder; false when it can't. */
  ensureUserDirectory(): boolean;
  /** Prunes the index's damaged copies past the newest five. */
  pruneDamagedIndexCopies(): void;
  /** The principal a write claims outside a writer context. */
  defaultWriter(): StorageWriterPrincipal;
  /** The module a write claims for admission. */
  readonly writerModule: string;
  /**
   * The definitions row's owner record (CAN-7690). Every write reads it under
   * the writer lock and is refused when it names another owner or can't be
   * read; with no record, the compiled ownership table decides.
   */
  ownerFlipRecordPath?(): string;
}

function safeReadFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

interface ResolvedPipelineEntry {
  entry: PipelineIndexEntry;
  source: 'user' | 'bundled';
  filePath: string;
}

export interface StoredPipelinePath {
  source: 'user' | 'bundled';
  filePath: string;
}

export type StoredPipelineWriteRefusal =
  | 'invalid'
  | 'not_found'
  | 'read_only'
  | 'exists'
  | 'revision_conflict'
  | 'index_newer'
  | 'index_unreadable'
  | 'index_damaged'
  | 'busy'
  | 'finalization_failed'
  | 'finalization_unconfirmed'
  | 'io'
  | 'owner_moved';

export type StoredPipelineWriteResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reason: StoredPipelineWriteRefusal;
      readonly message: string;
      /** For `owner_moved`: the owner that keeps the definitions now. */
      readonly owner?: StorageTransitionOwner;
    };

export type StoredPipelineInfo = PipelineInfo & { readonly revision: number };

export interface StoredPipelineWriteOptions {
  /** Trusted host precondition checked before publication under the writer lock. */
  readonly prepare?: (id: string) => StoredPipelineWriteResult<() => void>;
  /** Trusted host effect that must succeed under the writer lock. */
  readonly finalize?: (
    saved: StoredPipelineInfo,
  ) => StoredPipelineWriteResult<void>;
  readonly createId?: string;
  readonly expectedRevision?: number | null;
  readonly requireExisting?: boolean;
}

export type StoredPipelineIndexStatus =
  | 'ok'
  | 'missing'
  | 'damaged'
  | 'newer'
  | 'unreadable';

interface RawIndex {
  readonly rest: Record<string, unknown>;
  readonly entries: readonly unknown[];
}

type IndexRead =
  | { status: 'ok'; raw: RawIndex; bytes: string }
  | { status: 'missing'; raw: RawIndex }
  | { status: 'newer'; raw: RawIndex; hasPipelineArray: boolean }
  | { status: 'damaged'; bytes: string; rebuilt: RawIndex }
  | { status: 'unreadable'; code: string };

/**
 * The principal a host's writes claim and the rows that decide them
 * (CAN-5092), for pipeline_definitions and its lock only. The rows the
 * caller passes decide, so only trusted composition may pass them: tests
 * now, the daemon at the flip. check:daemon-writer-boundary refuses any
 * other production caller of `withStoredPipelineWriter`.
 */
export interface StoredPipelineWriterContext {
  readonly writer: StorageWriterPrincipal;
  readonly ownership: readonly StorageOwnershipRow[];
}

/** A stored definition's index entry and raw text, read for core. */
export type StoredPipelineDocumentRead =
  | { kind: 'missing' }
  | { kind: 'unreadable'; message: string }
  | {
      kind: 'found';
      source: 'user' | 'bundled';
      entry: PipelineIndexEntry;
      rawContent: string;
    };

export type StoredPipelineDocumentState =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'stored';
      readonly rawContent: string;
      readonly revision: number;
    }
  | { readonly kind: 'unlisted'; readonly rawContent: string }
  | { readonly kind: 'unreadable'; readonly message: string };

/** The definitions store's API, one instance per host (CAN-5092). */
export interface PipelineDefinitionStore {
  readonly readStoredPipelineIndexStatus: () => StoredPipelineIndexStatus;
  /**
   * Runs `run` with `context` as the store's writer. The context holds only
   * while `run` executes synchronously, so `run` must finish its writes before
   * it returns; work it leaves for later runs without the context.
   */
  readonly withStoredPipelineWriter: <T>(
    context: StoredPipelineWriterContext,
    run: () => T,
  ) => T;
  /** Runs a synchronous definition or sidecar write under the shared lock. */
  readonly withStoredPipelineDefinitionLock: <T>(
    run: () => StoredPipelineWriteResult<T>,
  ) => StoredPipelineWriteResult<T>;
  /**
   * Runs `run` with user id lookups sharing one read of the index (CAN-7087).
   * The snapshot holds only while `run` executes synchronously, and a write
   * through the store drops it.
   */
  readonly withStoredPipelineIndexSnapshot: <T>(run: () => T) => T;
  readonly findStoredUserPipelineIdByFilename: (
    filename: string,
  ) => string | undefined;
  readonly listStoredPipelines: () => IPCResult<PipelineInfo[]>;
  readonly getStoredPipeline: (id: string) => IPCResult<PipelineData>;
  readonly getStoredPipelineBySource: (
    source: 'bundled' | 'user',
    id: string,
  ) => IPCResult<PipelineData>;
  /** A stored definition's index entry, without reading its file. */
  readonly getStoredPipelineIndexEntry: (
    id: string,
    source: 'user' | 'bundled',
  ) => PipelineIndexEntry | null;
  /**
   * Read one stored definition by source, or by id with user before bundled.
   * Unlike the IPC readers, a missing entry is told apart from an unreadable
   * file, and the text is returned unparsed.
   */
  readonly readStoredPipelineDocument: (
    id: string,
    source?: 'user' | 'bundled',
  ) => StoredPipelineDocumentRead;
  /** Inspect the user document for recovery without locking or writing. */
  readonly inspectStoredPipelineDocument: (
    id: string,
  ) => StoredPipelineDocumentState;
  /** Remove only an unlisted document whose bytes still match under the writer lock. */
  readonly removeUnlistedStoredPipelineDocument: (
    id: string,
    expectedSha256: string,
  ) => StoredPipelineWriteResult<{ readonly removed: boolean }>;
  /** Presence for publish checks; damaged or unreadable state fails closed. */
  readonly readStoredPipelinePresence: (
    id: string,
  ) => 'present' | 'absent' | 'unreadable';
  readonly getStoredPipelineText: (id: string) => IPCResult<string>;
  readonly getStoredPipelinePath: (id: string) => IPCResult<string>;
  readonly getStoredPipelinePathWithSource: (
    id: string,
  ) => IPCResult<StoredPipelinePath>;
  readonly writeStoredPipeline: (
    input: PipelineSaveInput,
    options?: StoredPipelineWriteOptions,
  ) => StoredPipelineWriteResult<StoredPipelineInfo>;
  readonly saveStoredPipeline: (
    input: PipelineSaveInput,
    trustedCreate?: { id: string },
  ) => IPCResult<StoredPipelineInfo>;
  /** Persist the author-side cloud link beside a stored user pipeline. */
  readonly writeStoredPipelineRemoteMetadata: (
    id: string,
    remote: ShareRemoteMetadata,
  ) => IPCResult<PipelineInfo>;
  /** Clear every stored user pipeline linked to the deleted cloud share. */
  readonly clearStoredPipelineRemoteMetadataByRemoteId: (
    remoteId: string,
  ) => IPCResult<number>;
  /**
   * The stored revision of a user pipeline, `bundled` for a bundled id, or
   * `null` when neither store has it. Writes check the expected revision
   * again under the cross-process writer lock.
   */
  readonly readStoredPipelineRevision: (
    id: string,
  ) => { source: 'user'; revision: number } | { source: 'bundled' } | null;
  readonly removeStoredPipeline: (
    id: string,
    options?: { readonly expectedRevision?: number | null },
  ) => StoredPipelineWriteResult<{ readonly revision: number }>;
  readonly deleteStoredPipeline: (id: string) => IPCResult;
  readonly updateStoredPipeline: (
    id: string,
    input: PipelineSaveInput,
  ) => IPCResult<PipelineInfo>;
  readonly reconcileStoredPipelineIndex: () => StoredPipelineWriteResult<{
    readonly updated: number;
    readonly rebuilt: boolean;
  }>;
  readonly duplicateStoredPipeline: (id: string) => IPCResult<PipelineInfo>;
}

/** The pipeline definitions store over `env`; one instance per host. */
export function createPipelineDefinitionStore(
  env: PipelineDefinitionStoreEnvironment,
): PipelineDefinitionStore {
  function userPipelineIndexPath(): string {
    return env.userPipelineIndexPath();
  }

  const PIPELINE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  function isPipelineTriggerType(value: unknown): value is PipelineTriggerType {
    return (
      value === 'dispatch' ||
      value === 'plan_ready' ||
      value === 'task_ready' ||
      value === 'workflow'
    );
  }

  function isPathInside(rootDir: string, candidatePath: string): boolean {
    const relativePath = path.relative(rootDir, candidatePath);
    return (
      relativePath.length > 0 &&
      relativePath !== '..' &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath)
    );
  }

  function resolveUserPipelineFilePath(filename: string): string | null {
    const userDirPath = path.resolve(env.userPipelinesDir());
    const filePath = path.resolve(userDirPath, filename);
    return isPathInside(userDirPath, filePath) ? filePath : null;
  }

  /** A path's name in the user definitions folder; refuses any other path. */
  function userFileName(filePath: string): string {
    const resolved = path.resolve(filePath);
    if (path.dirname(resolved) !== path.resolve(env.userPipelinesDir()))
      throw new Error(`Not in the user workflow folder: ${filePath}`);
    return path.basename(resolved);
  }

  function isRegularFile(filePath: string, failOnUnreadable = false): boolean {
    try {
      const regular = statSync(filePath).isFile();
      if (failOnUnreadable && !regular)
        throw new Error(`Workflow document is not a regular file: ${filePath}`);
      return regular;
    } catch (error) {
      if (failOnUnreadable && errorCode(error) !== 'ENOENT') throw error;
      return false;
    }
  }

  function pipelineDocumentIdentity(filePath: string): string | null {
    try {
      const stats = statSync(filePath, { bigint: true });
      return stats.isFile() ? `${stats.dev}:${stats.ino}` : null;
    } catch {
      return null;
    }
  }

  function parseCuratedOrigin(
    value: unknown,
  ): CuratedPipelineOrigin | undefined {
    if (
      !isRecord(value) ||
      typeof value.key !== 'string' ||
      !isCuratedCatalogKey(value.key) ||
      typeof value.contentHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.contentHash) ||
      typeof value.revision !== 'number' ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 1 ||
      typeof value.importedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.importedAt))
    )
      return undefined;
    return {
      key: value.key,
      contentHash: value.contentHash,
      revision: value.revision,
      importedAt: value.importedAt,
    };
  }

  function parsePipelineIndexEntry(value: unknown): PipelineIndexEntry | null {
    if (!isRecord(value)) {
      return null;
    }

    const id = value.id;
    const name = value.name;
    const filename = value.filename;
    const createdAt = value.createdAt;
    const updatedAt = value.updatedAt;

    if (
      typeof id !== 'string' ||
      typeof name !== 'string' ||
      typeof filename !== 'string' ||
      typeof createdAt !== 'string' ||
      typeof updatedAt !== 'string'
    ) {
      return null;
    }

    const description =
      typeof value.description === 'string' ? value.description : '';
    const icon = typeof value.icon === 'string' ? value.icon : '';
    const triggerTypesValue = value.triggerTypes;
    const triggerTypes = Array.isArray(triggerTypesValue)
      ? triggerTypesValue.filter((entry): entry is PipelineTriggerType =>
          isPipelineTriggerType(entry),
        )
      : undefined;
    let scopes: PipelineExecutionScope[] | undefined;
    try {
      scopes =
        value.scopes === undefined
          ? undefined
          : normalizePipelineScopes(
              value.scopes,
              `Pipeline index entry "${id}"`,
            );
    } catch {
      scopes = undefined;
    }

    const curatedOrigin = parseCuratedOrigin(value.curatedOrigin);
    const remote = parseShareRemoteMetadata(value.remote);
    // The cached step count lets list reads skip reparsing each definition.
    const stepCount =
      typeof value.stepCount === 'number' &&
      Number.isInteger(value.stepCount) &&
      value.stepCount >= 0
        ? value.stepCount
        : undefined;
    const revision =
      typeof value.revision === 'number' &&
      Number.isSafeInteger(value.revision) &&
      value.revision > 0
        ? value.revision
        : undefined;
    return {
      id,
      name,
      filename,
      description,
      icon,
      createdAt,
      updatedAt,
      ...(curatedOrigin ? { curatedOrigin } : {}),
      ...(remote ? { remote } : {}),
      triggerTypes,
      scopes,
      ...(stepCount === undefined ? {} : { stepCount }),
      ...(revision === undefined ? {} : { revision }),
    };
  }

  const PIPELINE_DEFINITION_LOCK_MAX_WAIT_MS = 5_000;
  const PIPELINE_DEFINITION_LOCK_POLL_MS = 20;
  const LOCK_TIMEOUT_MESSAGE =
    'Another app is saving workflows. Try again in a moment.';
  let writerLockDepth = 0;
  let reportedDamagedIndex = false;

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  function errorCode(error: unknown): string {
    return isRecord(error) && typeof error.code === 'string'
      ? error.code
      : 'unknown';
  }

  function refused(
    reason: StoredPipelineWriteRefusal,
    message: string,
    owner?: StorageTransitionOwner,
  ): {
    readonly ok: false;
    readonly reason: StoredPipelineWriteRefusal;
    readonly message: string;
    readonly owner?: StorageTransitionOwner;
  } {
    return owner === undefined
      ? { ok: false, reason, message }
      : { ok: false, reason, message, owner };
  }

  /** A file's text, or the code of the error that kept it from being read. */
  function readTextFile(
    filePath: string,
  ): { readonly text: string } | { readonly code: string } {
    try {
      return { text: readFileSync(filePath, 'utf8') };
    } catch (error) {
      return { code: errorCode(error) };
    }
  }

  /**
   * The refusal for a write whose writer the definitions row's owner record
   * doesn't name (CAN-7690); undefined when the write may go ahead.
   */
  function ownerRefusal(): ReturnType<typeof refused> | undefined {
    const recordPath = env.ownerFlipRecordPath?.();
    if (recordPath === undefined) return undefined;
    const read = readTextFile(recordPath);
    const decision = decideRowWrite(
      'text' in read
        ? parseOwnerFlipRecord(read.text, 'pipeline_definitions')
        : read.code === 'ENOENT'
          ? { kind: 'absent' }
          : {
              kind: 'unreadable',
              reason: `The owner record could not be read (${read.code}).`,
            },
      writerContext?.writer ?? env.defaultWriter(),
    );
    return decision.allowed
      ? undefined
      : refused('owner_moved', decision.message, decision.owner);
  }

  function readRawIndex(): IndexRead {
    const read = readTextFile(userPipelineIndexPath());
    if (!('text' in read))
      return read.code === 'ENOENT'
        ? { status: 'missing', raw: { rest: {}, entries: [] } }
        : { status: 'unreadable', code: read.code };
    const bytes = read.text;
    let value: unknown;
    try {
      value = JSON.parse(bytes);
    } catch {
      value = null;
    }
    if (
      isRecord(value) &&
      !Array.isArray(value) &&
      typeof value.version === 'number' &&
      Number.isFinite(value.version) &&
      value.version > 1
    ) {
      const { pipelines, ...rest } = value;
      return {
        status: 'newer',
        raw: { rest, entries: Array.isArray(pipelines) ? pipelines : [] },
        hasPipelineArray: Array.isArray(pipelines),
      };
    }
    if (
      !isRecord(value) ||
      Array.isArray(value) ||
      !Array.isArray(value.pipelines)
    ) {
      return { status: 'damaged', bytes, rebuilt: rebuildIndexFromDocuments() };
    }
    const { pipelines, ...rest } = value;
    return { status: 'ok', raw: { rest, entries: pipelines }, bytes };
  }

  function visibleEntries(
    raw: RawIndex,
    inspectedId?: string,
  ): PipelineIndexEntry[] {
    const seenIds = new Set<string>();
    const seenFilenames = new Set<string>();
    const visible: PipelineIndexEntry[] = [];
    for (const value of raw.entries) {
      const entry = parsePipelineIndexEntry(value);
      if (!entry) continue;
      const filePath = resolveUserPipelineFilePath(entry.filename);
      if (
        filePath === null ||
        !isRegularFile(
          filePath,
          entry.id === inspectedId &&
            !seenIds.has(entry.id) &&
            !seenFilenames.has(entry.filename),
        ) ||
        seenIds.has(entry.id) ||
        seenFilenames.has(entry.filename)
      )
        continue;
      seenIds.add(entry.id);
      seenFilenames.add(entry.filename);
      visible.push(entry);
    }
    return visible;
  }

  function recoverableStepCount(value: unknown): number | null {
    if (!isRecord(value) || Array.isArray(value)) return null;
    const jobs = value.jobs;
    if (!isRecord(jobs) || Array.isArray(jobs)) return null;
    let count = 0;
    for (const job of Object.values(jobs)) {
      if (!isRecord(job) || !Array.isArray(job.steps)) return null;
      count += job.steps.length;
    }
    return count;
  }

  function rebuildIndexFromDocuments(): RawIndex {
    const entries: PipelineIndexEntry[] = [];
    for (const file of readdirSync(env.userPipelinesDir(), {
      withFileTypes: true,
    })) {
      if (!file.isFile() || !/^[A-Za-z0-9_-]+\.yaml$/.test(file.name)) continue;
      const id = file.name.slice(0, -5);
      if (!isSafePipelineId(id)) continue;
      const filePath = path.join(env.userPipelinesDir(), file.name);
      const loaded = loadPipelineFromFile(filePath);
      if (!loaded.success || !loaded.data) continue;
      const stepCount = recoverableStepCount(loaded.data);
      if (stepCount === null) continue;
      const content = loaded.data;
      const modified = statSync(filePath).mtime.toISOString();
      entries.push({
        id,
        filename: file.name,
        name:
          typeof content.name === 'string' && content.name.trim()
            ? content.name
            : id,
        description:
          typeof content.description === 'string' ? content.description : '',
        icon: '',
        // CAN-5239: a document has no install date, and its mtime is only
        // the last edit. The rebuilt row's date stays unknown, as do later
        // saves of it.
        createdAt: '',
        updatedAt: modified,
        revision: 1,
        triggerTypes: getTriggerTypes(content.on),
        scopes: derivePipelineScopes(content),
        stepCount,
      });
    }
    entries.sort(
      (a, b) =>
        a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id),
    );
    if (!reportedDamagedIndex) {
      reportedDamagedIndex = true;
      process.stderr.write(
        `[pipelines] The workflow list is damaged; listing ${entries.length} workflows rebuilt from their documents\n`,
      );
    }
    return { rest: {}, entries };
  }

  function readIndex(): PipelineIndex {
    const read = readRawIndex();
    return {
      pipelines:
        read.status === 'unreadable'
          ? []
          : visibleEntries(read.status === 'damaged' ? read.rebuilt : read.raw),
    };
  }

  function readStoredPipelineIndexStatus(): StoredPipelineIndexStatus {
    return readRawIndex().status;
  }

  // CAN-7087: inside withStoredPipelineIndexSnapshot, user id lookups share
  // one read of the index. Any write through the store drops it.
  let indexSnapshotDepth = 0;
  let indexSnapshot: ReadonlyMap<string, PipelineIndexEntry> | undefined;

  function withStoredPipelineIndexSnapshot<T>(run: () => T): T {
    indexSnapshotDepth += 1;
    try {
      return run();
    } finally {
      indexSnapshotDepth -= 1;
      if (indexSnapshotDepth === 0) indexSnapshot = undefined;
    }
  }

  function findUserEntry(id: string): PipelineIndexEntry | undefined {
    // A write in progress reads its own changes.
    if (indexSnapshotDepth === 0 || writerLockDepth > 0)
      return readIndex().pipelines.find((p) => p.id === id);
    // Visible entries have unique ids, so the map keeps `find`'s match.
    indexSnapshot ??= new Map(
      readIndex().pipelines.map((entry) => [entry.id, entry]),
    );
    const entry = indexSnapshot.get(id);
    // A copy, as a fresh read gives each caller.
    return entry === undefined ? undefined : structuredClone(entry);
  }

  let writerContext: StoredPipelineWriterContext | undefined;

  /**
   * Runs `run` with `context` as the store's writer. The context holds only
   * while `run` executes synchronously, so `run` must finish its writes before
   * it returns; work it leaves for later runs without the context.
   */
  function withStoredPipelineWriter<T>(
    context: StoredPipelineWriterContext,
    run: () => T,
  ): T {
    const previous = writerContext;
    writerContext = context;
    try {
      return run();
    } finally {
      writerContext = previous;
    }
  }

  /** Refuses a writer context the rows don't admit, before anything is touched. */
  function assertWriterContext(): void {
    if (writerContext)
      assertAdmittedWriter(
        'pipeline_definitions',
        writerContext.writer,
        env.writerModule,
        writerContext.ownership,
      );
  }

  function installDurably(filePath: string, data: string): boolean {
    try {
      env.installUserFile(userFileName(filePath), data, {
        namespace: 'pipeline_definitions',
        writer: writerContext?.writer ?? env.defaultWriter(),
        module: env.writerModule,
        ...(writerContext && { ownership: writerContext.ownership }),
      });
      return true;
    } catch (error) {
      if (!isStorageOutcomeUnknownError(error)) throw error;
      process.stderr.write(
        `[pipelines] ${filePath} installed, but its folder flush failed: ${errorMessage(error)}\n`,
      );
      return false;
    }
  }

  /**
   * A removed document persists only with its folder. Without the flush, power
   * loss could bring back a copy an install rollback removed after its record
   * is gone (CAN-5678). A failed flush leaves the removal made but unconfirmed,
   * which is logged, as for a write.
   */
  function flushRemovedDocuments(): void {
    const directory = env.userPipelinesDir();
    try {
      env.flushUserDirectory();
    } catch (error) {
      process.stderr.write(
        `[pipelines] ${directory} removal made, but its folder flush failed: ${errorMessage(error)}\n`,
      );
    }
  }

  function withDefinitionLock<T>(
    operation: () => StoredPipelineWriteResult<T>,
  ): StoredPipelineWriteResult<T> {
    indexSnapshot = undefined;
    try {
      assertWriterContext();
      if (writerLockDepth > 0) return operation();
      return env.withWriterLock(
        () => {
          writerLockDepth += 1;
          try {
            return ownerRefusal() ?? operation();
          } finally {
            writerLockDepth -= 1;
          }
        },
        {
          maxWaitMs: PIPELINE_DEFINITION_LOCK_MAX_WAIT_MS,
          pollMs: PIPELINE_DEFINITION_LOCK_POLL_MS,
          timeoutMessage: LOCK_TIMEOUT_MESSAGE,
        },
      );
    } catch (error) {
      const message = errorMessage(error);
      return refused(message === LOCK_TIMEOUT_MESSAGE ? 'busy' : 'io', message);
    } finally {
      indexSnapshot = undefined;
    }
  }

  function mutateIndex<T>(
    mutate: (
      raw: RawIndex,
      visible: PipelineIndexEntry[],
    ) => StoredPipelineWriteResult<{ next: RawIndex | null; value: T }>,
  ): StoredPipelineWriteResult<T> {
    return withDefinitionLock(() => {
      const read = readRawIndex();
      if (read.status === 'unreadable')
        return refused(
          'index_unreadable',
          `The workflow list cannot be read (${read.code}). Nothing was saved.`,
        );
      if (read.status === 'newer')
        return refused(
          'index_newer',
          'The workflow list was saved by a newer version of the app. Update the app to change workflows.',
        );
      const raw = read.status === 'damaged' ? read.rebuilt : read.raw;
      const result = mutate(raw, visibleEntries(raw));
      if (!result.ok) return result;
      if (result.value.next !== null) {
        if (!env.ensureUserDirectory())
          return refused(
            'io',
            `Failed to ensure pipeline directory: ${env.userPipelinesDir()}`,
          );
        if (read.status === 'damaged')
          installDurably(damagedCopyPath(userPipelineIndexPath()), read.bytes);
        installDurably(
          userPipelineIndexPath(),
          JSON.stringify(
            { ...result.value.next.rest, pipelines: result.value.next.entries },
            null,
            2,
          ),
        );
        if (read.status === 'damaged') env.pruneDamagedIndexCopies();
      }
      return { ok: true, value: result.value.value };
    });
  }

  function replaceRawEntry(raw: RawIndex, entry: PipelineIndexEntry): RawIndex {
    const entries: unknown[] = [];
    let replaced = false;
    for (const value of raw.entries) {
      if (
        isRecord(value) &&
        (value.id === entry.id || value.filename === entry.filename)
      ) {
        if (!replaced) {
          const known = new Set([
            'id',
            'name',
            'filename',
            'description',
            'icon',
            'createdAt',
            'updatedAt',
            'curatedOrigin',
            'triggerTypes',
            'stepCount',
            'scopes',
            'remote',
            'revision',
          ]);
          const unknown = Object.fromEntries(
            Object.entries(value).filter(([key]) => !known.has(key)),
          );
          entries.push({ ...unknown, ...entry });
          replaced = true;
        }
      } else entries.push(value);
    }
    if (!replaced) entries.push(entry);
    return { rest: raw.rest, entries };
  }

  function toIPCResult<T>(result: StoredPipelineWriteResult<T>): IPCResult<T> {
    return result.ok
      ? { success: true, data: result.value }
      : { success: false, error: result.message };
  }

  function readBundledIndex(): PipelineIndex {
    const raw = safeReadFile(
      path.join(env.bundledPipelinesDir(), 'index.json'),
    );
    if (raw) {
      try {
        return JSON.parse(raw) as PipelineIndex;
      } catch {
        /* corrupt */
      }
    }
    return { pipelines: [] };
  }

  function resolvePipelineEntry(id: string): ResolvedPipelineEntry | null {
    const userEntry = findUserEntry(id);
    if (userEntry) {
      const filePath = resolveUserPipelineFilePath(userEntry.filename);
      if (filePath === null) {
        return null;
      }
      return {
        entry: userEntry,
        source: 'user',
        filePath,
      };
    }

    const bundledIndex = readBundledIndex();
    const bundledEntry = bundledIndex.pipelines.find((p) => p.id === id);
    if (bundledEntry) {
      return {
        entry: bundledEntry,
        source: 'bundled',
        filePath: path.join(env.bundledPipelinesDir(), bundledEntry.filename),
      };
    }

    return null;
  }

  function resolvePipelineEntryBySource(
    source: 'user' | 'bundled',
    id: string,
  ): ResolvedPipelineEntry | null {
    if (source === 'user') {
      const userEntry = findUserEntry(id);
      if (!userEntry) {
        return null;
      }
      const filePath = resolveUserPipelineFilePath(userEntry.filename);
      if (filePath === null) {
        return null;
      }
      return {
        entry: userEntry,
        source,
        filePath,
      };
    }

    const bundledEntry = readBundledIndex().pipelines.find((p) => p.id === id);
    if (!bundledEntry) {
      return null;
    }
    return {
      entry: bundledEntry,
      source,
      filePath: path.join(env.bundledPipelinesDir(), bundledEntry.filename),
    };
  }

  function isSafePipelineId(id: string): boolean {
    if (!PIPELINE_ID_PATTERN.test(id)) return false;
    if (id.includes('\0')) return false;
    const normalized = path.normalize(id);
    if (normalized !== id) return false;
    if (path.basename(id) !== id) return false;
    if (path.posix.basename(id) !== id) return false;
    if (path.win32.basename(id) !== id) return false;
    return true;
  }

  function parsePipelineFile(
    raw: string,
    filePath: string,
  ): IPCResult<Pipeline> {
    try {
      const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA }) as {
        pipeline?: Pipeline;
      };
      return {
        success: true,
        data: parsed.pipeline ?? (parsed as unknown as Pipeline),
      };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? `Failed to parse workflow file ${path.basename(filePath)}: ${error.message}`
            : `Failed to parse workflow file ${path.basename(filePath)}: ${String(error)}`,
      };
    }
  }

  function loadPipelineFromFile(filePath: string): IPCResult<Pipeline> {
    const raw = safeReadFile(filePath);
    return raw
      ? parsePipelineFile(raw, filePath)
      : {
          success: false,
          error: `Workflow file not found: ${path.basename(filePath)}`,
        };
  }

  function derivePipelineScopes(
    pipeline: Pipeline,
  ): PipelineExecutionScope[] | undefined {
    try {
      return normalizePipeline(pipeline).scope;
    } catch {
      return undefined;
    }
  }

  function listStoredPipelines(): IPCResult<PipelineInfo[]> {
    try {
      const bundled = readBundledIndex().pipelines.map((p) => {
        const loaded = loadPipelineFromFile(
          path.join(env.bundledPipelinesDir(), p.filename),
        );
        const stepCount =
          loaded.success && loaded.data
            ? Object.values(loaded.data.jobs).reduce(
                (count, job) => count + job.steps.length,
                0,
              )
            : p.stepCount;
        return {
          ...p,
          ...(stepCount === undefined ? {} : { stepCount }),
          scopes: p.scopes ?? ['directory' as const],
          source: 'bundled' as const,
          readonly: true,
        };
      });
      const userIndex = readIndex();
      const user = userIndex.pipelines.map((p) => {
        if (p.triggerTypes && p.scopes && p.stepCount !== undefined) {
          return { ...p, source: 'user' as const, readonly: false };
        }
        const filePath = resolveUserPipelineFilePath(p.filename);
        const result =
          filePath === null
            ? {
                success: false,
                error: `Workflow file not found: ${p.filename}`,
              }
            : loadPipelineFromFile(filePath);
        const triggerTypes =
          result.success && result.data
            ? getTriggerTypes(result.data.on)
            : undefined;
        const scopes =
          result.success && result.data
            ? derivePipelineScopes(result.data)
            : undefined;
        const stepCount =
          result.success && result.data
            ? Object.values(result.data.jobs).reduce(
                (count, job) => count + job.steps.length,
                0,
              )
            : undefined;
        return {
          ...p,
          triggerTypes: triggerTypes ?? p.triggerTypes,
          scopes: scopes ?? p.scopes,
          stepCount: stepCount ?? p.stepCount,
          source: 'user' as const,
          readonly: false,
        };
      });
      return { success: true, data: [...bundled, ...user] };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  function getStoredPipeline(id: string): IPCResult<PipelineData> {
    try {
      const resolved = resolvePipelineEntry(id);
      if (!resolved) {
        return { success: false, error: `Workflow not found: ${id}` };
      }

      const rawContent = safeReadFile(resolved.filePath);
      if (!rawContent) {
        return {
          success: false,
          error: `Workflow file not found: ${resolved.entry.filename}`,
        };
      }
      const pipeline = parsePipelineFile(rawContent, resolved.filePath);
      if (!pipeline.success || !pipeline.data) {
        return { success: false, error: pipeline.error };
      }

      return {
        success: true,
        data: {
          info: {
            ...resolved.entry,
            scopes:
              resolved.entry.scopes ?? normalizePipeline(pipeline.data).scope,
            source: resolved.source,
            readonly: resolved.source === 'bundled',
          },
          content: pipeline.data,
          rawContent,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  function getStoredPipelineBySource(
    source: 'bundled' | 'user',
    id: string,
  ): IPCResult<PipelineData> {
    try {
      const resolved = resolvePipelineEntryBySource(source, id);
      if (!resolved) {
        return { success: false, error: `Workflow not found: ${id}` };
      }

      const rawContent = safeReadFile(resolved.filePath);
      if (!rawContent) {
        return {
          success: false,
          error: `Workflow file not found: ${resolved.entry.filename}`,
        };
      }
      const pipeline = parsePipelineFile(rawContent, resolved.filePath);
      if (!pipeline.success || !pipeline.data) {
        return { success: false, error: pipeline.error };
      }

      return {
        success: true,
        data: {
          info: {
            ...resolved.entry,
            scopes:
              resolved.entry.scopes ?? normalizePipeline(pipeline.data).scope,
            source: resolved.source,
            readonly: resolved.source === 'bundled',
          },
          content: pipeline.data,
          rawContent,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  /** A stored definition's index entry, without reading its file. */
  function getStoredPipelineIndexEntry(
    id: string,
    source: 'user' | 'bundled',
  ): PipelineIndexEntry | null {
    return resolvePipelineEntryBySource(source, id)?.entry ?? null;
  }

  /**
   * Read one stored definition by source, or by id with user before bundled.
   * Unlike the IPC readers, a missing entry is told apart from an unreadable
   * file, and the text is returned unparsed.
   */
  function readStoredPipelineDocument(
    id: string,
    source?: 'user' | 'bundled',
  ): StoredPipelineDocumentRead {
    const resolved = source
      ? resolvePipelineEntryBySource(source, id)
      : resolvePipelineEntry(id);
    if (!resolved) return { kind: 'missing' };
    const rawContent = safeReadFile(resolved.filePath);
    if (!rawContent) {
      return {
        kind: 'unreadable',
        message: `Workflow file not found: ${resolved.entry.filename}`,
      };
    }
    return {
      kind: 'found',
      source: resolved.source,
      entry: resolved.entry,
      rawContent,
    };
  }

  /** Inspect the user document for recovery without locking or writing. */
  function inspectStoredPipelineDocument(
    id: string,
  ): StoredPipelineDocumentState {
    if (!isSafePipelineId(id))
      return { kind: 'unreadable', message: `Invalid pipeline id: ${id}` };
    const read = readRawIndex();
    if (read.status === 'unreadable')
      return {
        kind: 'unreadable',
        message: 'The user pipeline index is unreadable',
      };
    try {
      const raw = read.status === 'damaged' ? read.rebuilt : read.raw;
      const entry = visibleEntries(raw, id).find(
        (candidate) => candidate.id === id,
      );
      if (read.status === 'damaged' && !entry)
        return {
          kind: 'unreadable',
          message: 'The user pipeline index is unreadable',
        };
      const filePath = entry
        ? resolveUserPipelineFilePath(entry.filename)
        : path.join(env.userPipelinesDir(), `${id}.yaml`);
      if (filePath === null)
        return { kind: 'unreadable', message: `Invalid pipeline id: ${id}` };
      if (!entry) lstatSync(filePath);
      const rawContent = readFileSync(filePath, 'utf8');
      return entry
        ? { kind: 'stored', rawContent, revision: entry.revision ?? 0 }
        : { kind: 'unlisted', rawContent };
    } catch (error) {
      return errorCode(error) === 'ENOENT'
        ? { kind: 'absent' }
        : { kind: 'unreadable', message: errorMessage(error) };
    }
  }

  /** Remove only an unlisted document whose bytes still match under the writer lock. */
  function removeUnlistedStoredPipelineDocument(
    id: string,
    expectedSha256: string,
  ): StoredPipelineWriteResult<{ readonly removed: boolean }> {
    return withDefinitionLock<{ readonly removed: boolean }>(() => {
      const status = readStoredPipelineIndexStatus();
      if (status === 'damaged')
        return refused(
          'invalid',
          `Workflow ${id} changed; it was not removed.`,
        );
      if (status === 'newer')
        return refused(
          'index_newer',
          'The workflow list was saved by a newer version of the app. Update the app to change workflows.',
        );
      const state = inspectStoredPipelineDocument(id);
      if (state.kind === 'absent')
        return { ok: true, value: { removed: false } };
      if (
        state.kind !== 'unlisted' ||
        createHash('sha256').update(state.rawContent).digest('hex') !==
          expectedSha256
      )
        return refused(
          'invalid',
          `Workflow ${id} changed; it was not removed.`,
        );
      env.removeUserFile(`${id}.yaml`);
      flushRemovedDocuments();
      return { ok: true, value: { removed: true } };
    });
  }

  /** Presence for publish checks; damaged or unreadable state fails closed. */
  function readStoredPipelinePresence(
    id: string,
  ): 'present' | 'absent' | 'unreadable' {
    if (!isSafePipelineId(id)) return 'unreadable';
    const read = readRawIndex();
    if (
      read.status === 'damaged' ||
      read.status === 'unreadable' ||
      (read.status === 'newer' && !read.hasPipelineArray)
    )
      return 'unreadable';
    const value = read.raw.entries.find(
      (candidate) => isRecord(candidate) && candidate.id === id,
    );
    if (value === undefined) return 'absent';
    const entry = parsePipelineIndexEntry(value);
    if (!entry) return 'unreadable';
    const filePath = resolveUserPipelineFilePath(entry.filename);
    if (filePath === null) return 'unreadable';
    try {
      if (!statSync(filePath).isFile()) return 'unreadable';
      readFileSync(filePath, 'utf8');
      return 'present';
    } catch (error) {
      return errorCode(error) === 'ENOENT' ? 'absent' : 'unreadable';
    }
  }

  function getStoredPipelineText(id: string): IPCResult<string> {
    try {
      const resolved = resolvePipelineEntry(id);
      if (!resolved) {
        return { success: false, error: `Workflow not found: ${id}` };
      }

      const raw = safeReadFile(resolved.filePath);
      if (!raw) {
        return {
          success: false,
          error: `Workflow file not found: ${resolved.entry.filename}`,
        };
      }

      return { success: true, data: raw };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  function getStoredPipelinePath(id: string): IPCResult<string> {
    try {
      const resolved = resolvePipelineEntry(id);
      if (!resolved) {
        return { success: false, error: `Workflow not found: ${id}` };
      }

      return { success: true, data: resolved.filePath };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  function getStoredPipelinePathWithSource(
    id: string,
  ): IPCResult<StoredPipelinePath> {
    try {
      const resolved = resolvePipelineEntry(id);
      if (!resolved) {
        return { success: false, error: `Workflow not found: ${id}` };
      }

      return {
        success: true,
        data: {
          source: resolved.source,
          filePath: resolved.filePath,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  function writeStoredPipeline(
    input: PipelineSaveInput,
    options: StoredPipelineWriteOptions = {},
  ): StoredPipelineWriteResult<StoredPipelineInfo> {
    try {
      assertWriterContext();
    } catch (error) {
      return refused('io', errorMessage(error));
    }
    const userDir = env.userPipelinesDir();
    if (!env.ensureUserDirectory())
      return refused('io', `Failed to ensure pipeline directory: ${userDir}`);
    const requested = options.createId ?? input.id?.trim();
    if (requested && !isSafePipelineId(requested))
      return refused('invalid', `Invalid pipeline id: ${requested}`);
    const contentToSave: Pipeline = { ...input.content };
    delete contentToSave.readonly;
    let scopes: PipelineExecutionScope[];
    let yamlContent: string;
    try {
      if (input.rawContent !== undefined) {
        const rawPipeline = { ...parsePipelineText(input.rawContent) };
        delete rawPipeline.readonly;
        if (!isDeepStrictEqual(rawPipeline, contentToSave))
          return refused(
            'invalid',
            'Raw pipeline document does not match parsed pipeline content.',
          );
      }
      scopes = normalizePipeline(contentToSave).scope;
      yamlContent =
        input.rawContent ?? serializePipelineDocument(contentToSave);
    } catch (error) {
      return refused('invalid', errorMessage(error));
    }
    return withDefinitionLock(() => {
      let undo: (() => void) | undefined;
      let restoreIndex: (() => void) | undefined;
      let restorePreparation: (() => void) | undefined;
      let finalizing = false;
      try {
        const read = readRawIndex();
        if (read.status === 'unreadable')
          return refused(
            'index_unreadable',
            `The workflow list cannot be read (${read.code}). Nothing was saved.`,
          );
        if (read.status === 'newer')
          return refused(
            'index_newer',
            'The workflow list was saved by a newer version of the app. Update the app to change workflows.',
          );
        const finalize = options.finalize;
        const indexPath = userPipelineIndexPath();
        const previousIndex =
          finalize && read.status !== 'missing' ? read.bytes : null;
        const raw = read.status === 'damaged' ? read.rebuilt : read.raw;
        const visible = visibleEntries(raw);
        const existing = visible.find((entry) => entry.id === requested);
        // A create killed between its document and index installs leaves the
        // document with no entry: the same request may adopt it as it is.
        let adoptable = false;
        if (options.createId !== undefined) {
          let taken = false;
          let regular = false;
          try {
            regular = lstatSync(
              path.join(userDir, `${options.createId}.yaml`),
            ).isFile();
            taken = true;
          } catch (error) {
            if (errorCode(error) !== 'ENOENT') throw error;
          }
          const createId = options.createId;
          adoptable =
            taken &&
            regular &&
            !!requested &&
            !existing &&
            !raw.entries.some(
              (value) =>
                isRecord(value) &&
                (value.id === createId ||
                  value.filename === `${createId}.yaml`),
            );
          if (!requested || existing || (taken && !adoptable))
            return refused(
              'exists',
              'Pipeline create identity already exists or is invalid',
            );
        }
        if (options.requireExisting && !existing) {
          return readBundledIndex().pipelines.some(
            (entry) => entry.id === requested,
          )
            ? refused(
                'read_only',
                `Cannot update bundled workflow: ${requested}`,
              )
            : refused('not_found', `Workflow not found: ${requested}`);
        }
        if (
          typeof options.expectedRevision === 'number' &&
          existing &&
          (existing.revision ?? 0) !== options.expectedRevision
        )
          return refused(
            'revision_conflict',
            `Workflow changed since it was loaded: ${requested}`,
          );
        const id = options.createId ?? (existing ? existing.id : randomUUID());
        const filename = `${id}.yaml`;
        const filePath = resolveUserPipelineFilePath(filename);
        if (!filePath)
          return refused('invalid', `Invalid pipeline path for id: ${id}`);
        let onDisk: Buffer | null = null;
        if (existing || adoptable) {
          try {
            onDisk = readFileSync(filePath);
          } catch {
            onDisk = null;
          }
        }
        const previousBytes =
          existing && onDisk ? onDisk.toString('utf8') : null;
        if (finalize && existing && previousBytes === null)
          return refused('io', 'The previous workflow could not be read.');
        // Only a document holding exactly this create's bytes is adopted.
        const adopted =
          adoptable &&
          onDisk !== null &&
          onDisk.equals(Buffer.from(yamlContent, 'utf8'));
        if (adoptable && !adopted)
          return refused(
            'exists',
            'Pipeline create identity already exists or is invalid',
          );
        if (read.status === 'damaged')
          installDurably(damagedCopyPath(userPipelineIndexPath()), read.bytes);
        const prepared = options.prepare?.(id);
        if (prepared && !prepared.ok) return prepared;
        // An adopted document can survive without its index entry.
        if (!adopted) restorePreparation = prepared?.value;
        if (!adopted) installDurably(filePath, yamlContent);
        undo = adopted
          ? undefined
          : existing
            ? previousBytes === null
              ? undefined
              : (): void => {
                  installDurably(filePath, previousBytes);
                }
            : (): void => env.removeUserFile(userFileName(filePath));
        const now = new Date().toISOString();
        const curatedOrigin = parseCuratedOrigin(
          input.curatedOrigin ?? existing?.curatedOrigin,
        );
        const entry: PipelineIndexEntry & { revision: number } = {
          id,
          name: input.name,
          filename,
          description: input.description,
          icon: input.icon,
          // CAN-5239: the install date is this host's time at the copy's
          // first save. Later saves keep the stored value, even an unknown
          // one; the input carries no date.
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          ...(curatedOrigin ? { curatedOrigin } : {}),
          ...(existing?.remote ? { remote: existing.remote } : {}),
          revision: existing ? (existing.revision ?? 0) + 1 : 1,
          triggerTypes: getTriggerTypes(contentToSave.on),
          stepCount: Object.values(contentToSave.jobs).reduce(
            (count, job) => count + job.steps.length,
            0,
          ),
          scopes,
        };
        const next = replaceRawEntry(raw, entry);
        const indexConfirmed = installDurably(
          indexPath,
          JSON.stringify({ ...next.rest, pipelines: next.entries }, null, 2),
        );
        const saved: StoredPipelineInfo = {
          ...entry,
          source: 'user',
          readonly: false,
        };
        if (finalize) {
          restoreIndex =
            previousIndex === null
              ? (): void => env.removeUserFile(userFileName(indexPath))
              : (): void => {
                  installDurably(indexPath, previousIndex);
                };
          finalizing = true;
          // The document and index share a directory. Confirm their publication
          // before a host effect can change which metadata applies to them.
          if (!indexConfirmed) env.flushUserDirectory();
          const finalized = finalize(saved);
          if (!finalized.ok) {
            // The host could not undo its effect. Keep the confirmed revision
            // instead of restoring a definition whose prior metadata may be gone.
            if (finalized.reason === 'finalization_unconfirmed')
              return finalized;
            throw new Error(finalized.message);
          }
        }
        if (read.status === 'damaged') env.pruneDamagedIndexCopies();
        return { ok: true, value: saved };
      } catch (error) {
        const message = errorMessage(error);
        try {
          undo?.();
          restoreIndex?.();
          if (finalizing || (restorePreparation && (undo || restoreIndex)))
            env.flushUserDirectory();
          else if (undo || restoreIndex) flushRemovedDocuments();
          restorePreparation?.();
        } catch (undoError) {
          return refused(
            finalizing ? 'finalization_unconfirmed' : 'io',
            `${message} The previous workflow state could not be restored: ${errorMessage(undoError)}`,
          );
        }
        return refused(
          finalizing ? 'finalization_failed' : 'io',
          finalizing ? `${message} The workflow change was undone.` : message,
        );
      }
    });
  }

  function saveStoredPipeline(
    input: PipelineSaveInput,
    trustedCreate?: { id: string },
  ): IPCResult<StoredPipelineInfo> {
    return toIPCResult(
      writeStoredPipeline(
        input,
        trustedCreate ? { createId: trustedCreate.id } : {},
      ),
    );
  }

  /** Persist the author-side cloud link beside a stored user pipeline. */
  function writeStoredPipelineRemoteMetadata(
    id: string,
    remote: ShareRemoteMetadata,
  ): IPCResult<PipelineInfo> {
    return toIPCResult(
      mutateIndex<PipelineInfo>((raw, visible) => {
        const existing = visible.find((entry) => entry.id === id);
        if (!existing) return refused('not_found', `Workflow not found: ${id}`);
        const entry = { ...existing, remote: { ...remote } };
        return {
          ok: true,
          value: {
            next: replaceRawEntry(raw, entry),
            value: { ...entry, source: 'user', readonly: false },
          },
        };
      }),
    );
  }

  /** Clear every stored user pipeline linked to the deleted cloud share. */
  function clearStoredPipelineRemoteMetadataByRemoteId(
    remoteId: string,
  ): IPCResult<number> {
    return toIPCResult(
      mutateIndex((raw, visible) => {
        const ids = new Set(
          visible
            .filter((entry) => entry.remote?.remoteId === remoteId)
            .map((entry) => entry.id),
        );
        const entries = raw.entries.map((value) => {
          if (
            !isRecord(value) ||
            typeof value.id !== 'string' ||
            !ids.has(value.id)
          )
            return value;
          const next = { ...value };
          delete next.remote;
          return next;
        });
        return {
          ok: true,
          value: {
            next: ids.size ? { rest: raw.rest, entries } : null,
            value: ids.size,
          },
        };
      }),
    );
  }

  /**
   * The stored revision of a user pipeline, `bundled` for a bundled id, or
   * `null` when neither store has it. Writes check the expected revision
   * again under the cross-process writer lock.
   */
  function readStoredPipelineRevision(
    id: string,
  ): { source: 'user'; revision: number } | { source: 'bundled' } | null {
    const entry = findUserEntry(id);
    if (entry) return { source: 'user', revision: entry.revision ?? 0 };
    return readBundledIndex().pipelines.some((p) => p.id === id)
      ? { source: 'bundled' }
      : null;
  }

  function removeStoredPipeline(
    id: string,
    options: { readonly expectedRevision?: number | null } = {},
  ): StoredPipelineWriteResult<{ readonly revision: number }> {
    return withDefinitionLock(() => {
      let removed: readonly unknown[] = [];
      const retainedPaths = new Set<string>();
      const retainedIdentities = new Set<string>();
      const result = mutateIndex((raw, visible) => {
        const existing =
          visible.find((entry) => entry.id === id) ??
          raw.entries
            .map(parsePipelineIndexEntry)
            .find((entry) => entry?.id === id);
        if (!existing)
          return readBundledIndex().pipelines.some((entry) => entry.id === id)
            ? refused('read_only', `Cannot delete bundled workflow: ${id}`)
            : refused('not_found', `Workflow not found: ${id}`);
        if (
          typeof options.expectedRevision === 'number' &&
          (existing.revision ?? 0) !== options.expectedRevision
        )
          return refused(
            'revision_conflict',
            `Workflow changed since it was loaded: ${id}`,
          );
        removed = raw.entries.filter(
          (value) => isRecord(value) && value.id === id,
        );
        const remaining = raw.entries.filter(
          (value) => !isRecord(value) || value.id !== id,
        );
        for (const value of remaining) {
          if (!isRecord(value) || typeof value.filename !== 'string') continue;
          const filePath = resolveUserPipelineFilePath(value.filename);
          if (filePath) {
            retainedPaths.add(filePath);
            const identity = pipelineDocumentIdentity(filePath);
            if (identity !== null) retainedIdentities.add(identity);
          }
        }
        return {
          ok: true,
          value: {
            next: {
              rest: raw.rest,
              entries: remaining,
            },
            value: { revision: existing.revision ?? 0 },
          },
        };
      });
      if (result.ok) {
        const filenames = new Set(
          removed.flatMap((value) =>
            isRecord(value) && typeof value.filename === 'string'
              ? [value.filename]
              : [],
          ),
        );
        let unlinked = false;
        for (const filename of filenames) {
          if (!/^[A-Za-z0-9_-]+\.yaml$/.test(filename)) continue;
          const filePath = resolveUserPipelineFilePath(filename);
          if (!filePath || retainedPaths.has(filePath)) continue;
          const identity = pipelineDocumentIdentity(filePath);
          if (identity !== null && retainedIdentities.has(identity)) continue;
          try {
            env.removeUserFile(userFileName(filePath));
            unlinked = true;
          } catch (error) {
            if (errorCode(error) !== 'ENOENT')
              process.stderr.write(
                `[pipelines] ${filePath} could not be removed: ${errorMessage(error)}\n`,
              );
          }
        }
        if (unlinked) flushRemovedDocuments();
      }
      return result;
    });
  }

  function deleteStoredPipeline(id: string): IPCResult {
    const result = removeStoredPipeline(id);
    return result.ok
      ? { success: true }
      : { success: false, error: result.message };
  }

  function updateStoredPipeline(
    id: string,
    input: PipelineSaveInput,
  ): IPCResult<PipelineInfo> {
    return toIPCResult(
      writeStoredPipeline({ ...input, id }, { requireExisting: true }),
    );
  }

  function reconcileStoredPipelineIndex(): StoredPipelineWriteResult<{
    readonly updated: number;
    readonly rebuilt: boolean;
  }> {
    return mutateIndex((raw, visible) => {
      const rebuilt = readStoredPipelineIndexStatus() === 'damaged';
      let updated = 0;
      const byId = new Map(visible.map((entry) => [entry.id, entry]));
      const entries = raw.entries.map((value) => {
        if (
          !isRecord(value) ||
          typeof value.id !== 'string' ||
          !parsePipelineIndexEntry(value)
        )
          return value;
        const entry = byId.get(value.id);
        if (!entry || value.filename !== entry.filename) return value;
        byId.delete(value.id);
        const filePath = resolveUserPipelineFilePath(entry.filename);
        const loaded = filePath ? loadPipelineFromFile(filePath) : null;
        if (!loaded?.success || !loaded.data) return value;
        const stepCount = recoverableStepCount(loaded.data);
        if (stepCount === null) return value;
        const scopes = derivePipelineScopes(loaded.data);
        const metadata = {
          triggerTypes: getTriggerTypes(loaded.data.on),
          ...(scopes === undefined ? {} : { scopes }),
          stepCount,
        };
        if (
          Object.entries(metadata).every(([key, field]) =>
            isDeepStrictEqual(value[key], field),
          )
        )
          return value;
        updated += 1;
        return { ...value, ...metadata };
      });
      return {
        ok: true,
        value: {
          next: updated || rebuilt ? { rest: raw.rest, entries } : null,
          value: { updated, rebuilt },
        },
      };
    });
  }

  function duplicateStoredPipeline(id: string): IPCResult<PipelineInfo> {
    try {
      const result = getStoredPipeline(id);
      if (!result.success || !result.data) {
        return { success: false, error: result.error || 'Source not found' };
      }

      const content: Pipeline = { ...result.data.content };
      delete content.readonly;

      return saveStoredPipeline({
        name: `${result.data.info.name} (Copy)`,
        curatedOrigin: result.data.info.curatedOrigin,
        description: result.data.info.description,
        icon: result.data.info.icon,
        content,
      });
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  return {
    readStoredPipelineIndexStatus,
    withStoredPipelineWriter,
    withStoredPipelineDefinitionLock: withDefinitionLock,
    withStoredPipelineIndexSnapshot,
    findStoredUserPipelineIdByFilename: (filename) =>
      readIndex().pipelines.find((entry) => entry.filename === filename)?.id,
    listStoredPipelines,
    getStoredPipeline,
    getStoredPipelineBySource,
    getStoredPipelineIndexEntry,
    readStoredPipelineDocument,
    inspectStoredPipelineDocument,
    removeUnlistedStoredPipelineDocument,
    readStoredPipelinePresence,
    getStoredPipelineText,
    getStoredPipelinePath,
    getStoredPipelinePathWithSource,
    writeStoredPipeline,
    saveStoredPipeline,
    writeStoredPipelineRemoteMetadata,
    clearStoredPipelineRemoteMetadataByRemoteId,
    readStoredPipelineRevision,
    removeStoredPipeline,
    deleteStoredPipeline,
    updateStoredPipeline,
    reconcileStoredPipelineIndex,
    duplicateStoredPipeline,
  };
}
