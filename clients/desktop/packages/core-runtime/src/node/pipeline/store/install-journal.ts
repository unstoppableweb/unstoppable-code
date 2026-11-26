/**
 * Install intent records (CAN-5633). One pipeline install writes several
 * stores: the definition, its package install record and, for a scoped
 * share, its install receipt. Each publishes atomically on its own, so an
 * exit between two of them used to leave a partial install, such as a copy
 * with no install record that a reinstall then duplicated.
 *
 * An install now records what it is about to change, durably, before each
 * write: the definition it creates or replaces (with the replaced document),
 * the install record it writes (with the one it replaces) and the receipt it
 * records. A finished install removes its record. A record left behind
 * belongs to an install that exited or failed partway, and is rolled back:
 * on a failure in the process, and otherwise once at startup, before any
 * install starts. Rollback only undoes a write while it still holds what
 * the install wrote, so it never discards a later edit, and it keeps the
 * record when an undo fails so the next startup retries it.
 *
 * An automation update that changes the supporting files of a pipeline that
 * stays also keeps every file it overwrites (CAN-5677): copied into a
 * private folder beside the record, `<intents>/<id>/`, before the record
 * notes them, so rollback can put them back.
 *
 * Electron main is the only writer, under the single-instance lock.
 *
 * The journal works through a host's environment (CAN-7058): its paths,
 * durable writes, stores and logging. Electron main builds the only one.
 */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import * as path from 'node:path';
import { parsePipelineText } from '@canopy/pipeline-interop/parse-pipeline';
import { isSafeCapabilityRelativePath } from '@canopy/protocol/capability-files';
import type { PipelineAssetInstallPlan } from './assets';
import type { PipelineDefinitionStore } from './definitions-store';

/** The install record fields the journal reads; a host's records hold more. */
export interface PipelineInstallJournalRecord {
  readonly pipelineContentHash: string;
  readonly distributionMode?: 'package' | 'definition_only';
  readonly packageDigest?: string;
  readonly originExternalId?: string;
  readonly localContentHash?: string;
}

/** The owner a pipeline's package install record is kept under. */
interface PipelineInstallOwner {
  readonly kind: 'pipeline';
  readonly localPipelineId: string;
}

/** The install committed and still needs recovery before it can run. */
export class PipelineInstallCleanupPendingError extends Error {
  constructor() {
    super('The workflow was installed. Restart the app to finish the install.');
    this.name = 'PipelineInstallCleanupPendingError';
  }
}

/** A host store the journal needs to settle an install. */
export type PipelineInstallJournalHostPort =
  | 'install_records'
  | 'install_receipts'
  | 'shared_item_ledger'
  | 'agent_markers';

interface CommittedPipelineSubscription {
  readonly localId: string;
  readonly remoteId: string;
  readonly sourceKind: 'shared' | 'public';
  readonly contentHash: string | null;
  readonly observedLedgerVersion?: string | null;
}

interface CommittedMarkerClear {
  readonly definitionId: string;
  readonly revision: number;
}

/**
 * A record needs a store this host doesn't have, so it is left as it is for
 * a host that has it (CAN-7058): nothing of it is undone, rewritten or
 * removed, and what it covers stays claimed in this process.
 */
export class PipelineInstallJournalLeftForHostError extends Error {
  readonly reason = 'needs_host_port';
  readonly port: PipelineInstallJournalHostPort;

  constructor(port: PipelineInstallJournalHostPort) {
    super(
      `An install record needs the ${port} store, so it is left for a host that has it`,
    );
    this.name = 'PipelineInstallJournalLeftForHostError';
    this.port = port;
  }
}

/**
 * The stores, paths and logging the journal works through. `TReceipt` and
 * `TRecord` are the host's install receipt and install record types.
 */
export interface PipelineInstallJournalEnvironment<
  TReceipt,
  TRecord extends PipelineInstallJournalRecord,
> {
  /** `<data>/pipeline-install-intents/`, one record per unfinished install. */
  readonly getPipelineInstallIntentsDir: () => string;
  readonly getDataDir: () => string;
  readonly getPipelineAssetsDir: (definitionId: string) => string;
  readonly getPipelineAssetsManifestPath: (definitionId: string) => string;
  /**
   * Throws, before anything is written, when this host may not write the
   * journal's stores: before an install's first write, at the start of
   * recovery and before each rollback.
   */
  readonly assertWritable: () => void | Promise<void>;
  readonly createDirectoryDurably: (
    directoryPath: string,
    options: { readonly dataRoot: string },
  ) => Promise<void>;
  readonly syncDirectory: (directoryPath: string) => Promise<void>;
  readonly writeFileAtomically: (
    targetPath: string,
    data: string | Uint8Array,
    options: { readonly mode?: number; readonly durable: true },
  ) => Promise<void>;
  readonly writeStoreFileDurably: (
    targetPath: string,
    data: string,
    options: { readonly encoding: 'utf8'; readonly mode: number },
  ) => Promise<void>;
  readonly definitions: Pick<
    PipelineDefinitionStore,
    | 'inspectStoredPipelineDocument'
    | 'removeUnlistedStoredPipelineDocument'
    | 'removeStoredPipeline'
    | 'writeStoredPipeline'
  >;
  /** Reads a definition an install replaces, to keep it for rollback. */
  readonly pipelineService: {
    readonly getPipeline: PipelineDefinitionStore['getStoredPipeline'];
    readonly getPipelineText: PipelineDefinitionStore['getStoredPipelineText'];
  };
  readonly deleteUserPipelineLocalMetadata: (definitionId: string) => void;
  /** Clears only the saved revision's marker. Throws if the check or clear fails. */
  readonly clearInstalledPipelineMarker?: (
    marker: CommittedMarkerClear,
  ) => void;
  readonly recordCommittedSubscription?: (
    subscription: CommittedPipelineSubscription,
    recovery: 'live' | 'replay',
  ) => Promise<void>;
  /**
   * The host's package install records. A host without them leaves every
   * record that notes one, or creates a definition, as it is.
   */
  readonly installRecords?: {
    readonly storePath: () => string;
    readonly find: (
      storePath: string,
      owner: PipelineInstallOwner,
    ) => Promise<TRecord | null>;
    readonly upsert: (storePath: string, record: TRecord) => Promise<void>;
    readonly remove: (
      storePath: string,
      owner: PipelineInstallOwner,
    ) => Promise<void>;
  };
  /** The account's install receipts; a host without them leaves receipts. */
  readonly installReceipts?: (accountId: string) => {
    readonly rollbackInstall: (
      receipt: TReceipt,
      previous: TReceipt | undefined,
    ) => Promise<void>;
  };
  readonly isInstallReceipt: (value: unknown) => value is TReceipt;
  /** The shared-item ledger; a host without it leaves created definitions. */
  readonly recordSharedItemLocalUninstall?: (item: {
    readonly kind: 'pipeline';
    readonly localId: string;
  }) => void;
  /** Removes a file, or with `recursive` a folder; `force` ignores absence. */
  readonly removePath: (
    target: string,
    options?: { readonly recursive?: boolean; readonly force?: boolean },
  ) => Promise<void>;
  /** Removes a folder only while it is empty. */
  readonly removeEmptyFolder: (folder: string) => Promise<void>;
  readonly renamePath: (source: string, destination: string) => Promise<void>;
  readonly makeFolder: (
    folder: string,
    options: { readonly recursive: true; readonly mode: number },
  ) => Promise<unknown>;
  /** Keeps the newest set-aside copies whose names match `prefix`. */
  readonly pruneDamagedCopies: (names: {
    readonly directory: string;
    readonly prefix: RegExp;
  }) => Promise<unknown>;
  /** Notes a definition a rollback removed (CAN-7347). */
  readonly noteDefinitionRemoved: (
    definitionId: string,
    removal: 'undone',
  ) => void;
  readonly definitionRemoval: (
    definitionId: string,
  ) => 'undone' | 'deleted' | undefined;
  readonly warn: (message: string, context?: unknown) => void;
  /** The timer a run start waits on for its definition's rollback (CAN-7308). */
  readonly setTimeout: (run: () => void, waitMs: number) => NodeJS.Timeout;
  readonly clearTimeout: (timer: NodeJS.Timeout) => void;
}

/** A definition document's hash, as the package contract computes it. */
function hashPipelinePackageYaml(rawPipeline: string): string {
  return createHash('sha256').update(rawPipeline).digest('hex');
}

const INTENT_VERSION = 4;
export const INTENT_FILE = /^[0-9a-f-]{36}\.json$/;
const INTENT_ID = /^[0-9a-f-]{36}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UNREADABLE_INTENT_PREFIX = /[0-9a-f-]{36}\.json\.unreadable-/;
const UNREADABLE_SNAPSHOTS = /^([0-9a-f-]{36})(\.unreadable-\d+)$/;

/** Which install wrote the record; for diagnostics only. */
export type PipelineInstallIntentSource =
  | 'shared'
  | 'curated'
  | 'package_share'
  | 'automation';

interface ReplacedDefinition {
  text: string;
  name: string;
  description: string;
  icon: string;
}

/** What a supporting file held before the install wrote it. */
type PreviousAssetFile =
  /** Copied to `<intents>/<id>/<sha256>`. */
  | { kind: 'file'; sha256: string; mode: number }
  | { kind: 'symlink'; target: string };

interface IntentAssetFile {
  /** Relative to the pipeline's asset dir. */
  path: string;
  /** sha256 of what the install writes. */
  next: string;
  /** null: the install adds the file. */
  previous: PreviousAssetFile | null;
}

/**
 * The supporting files an install changes in a pipeline: each file it
 * writes, the folders it creates, and `assets.json`.
 */
interface IntentAssets {
  files: IntentAssetFile[];
  createdDirectories: string[];
  manifest: { previous: string | null; next: string };
  /**
   * The `.install-<uuid>` folder name the install stages its files in
   * (CAN-7058). Absent in a record written before it was recorded; such a
   * record leaves any staging folders as they are.
   */
  staging?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAssetRelativePath(value: unknown): value is string {
  return value === '.' || isSafeCapabilityRelativePath(value);
}

function parsePreviousAssetFile(
  value: unknown,
): PreviousAssetFile | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  if (
    value.kind === 'file' &&
    typeof value.sha256 === 'string' &&
    SHA256.test(value.sha256) &&
    typeof value.mode === 'number' &&
    Number.isInteger(value.mode)
  )
    return { kind: 'file', sha256: value.sha256, mode: value.mode };
  if (value.kind === 'symlink' && typeof value.target === 'string')
    return { kind: 'symlink', target: value.target };
  return undefined;
}

function parseIntentAssets(value: unknown): IntentAssets | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.files) ||
    !Array.isArray(value.createdDirectories) ||
    !isRecord(value.manifest) ||
    (value.manifest.previous !== null &&
      typeof value.manifest.previous !== 'string') ||
    typeof value.manifest.next !== 'string'
  )
    return null;
  const files: IntentAssetFile[] = [];
  for (const file of value.files) {
    if (
      !isRecord(file) ||
      !isSafeCapabilityRelativePath(file.path) ||
      typeof file.next !== 'string'
    )
      return null;
    const previous = parsePreviousAssetFile(file.previous);
    if (previous === undefined) return null;
    files.push({ path: file.path, next: file.next, previous });
  }
  const createdDirectories: string[] = [];
  for (const folder of value.createdDirectories) {
    if (!isAssetRelativePath(folder)) return null;
    createdDirectories.push(folder);
  }
  const assets: IntentAssets = {
    files,
    createdDirectories,
    manifest: { previous: value.manifest.previous, next: value.manifest.next },
  };
  if (value.staging !== undefined) {
    if (
      typeof value.staging !== 'string' ||
      !INSTALL_STAGING.test(value.staging)
    )
      return null;
    assets.staging = value.staging;
  }
  return assets;
}

/**
 * The ids the definitions store accepts (its `isSafePipelineId`). The shape
 * has no dot, separator or NUL, so it is already one plain folder name on
 * every system.
 */
const STORED_PIPELINE_ID = /^[A-Za-z0-9_-]+$/;

function sha256Of(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * What a rollback found on the way to a path: `real` when the pipeline's
 * data folder and every folder down to and including `folder` are real
 * folders, `missing` when one of them is not there, `refused` when one is a
 * link or not a folder, or `folder` is outside the pipeline's data folder.
 */
type FolderChain = 'real' | 'missing' | 'refused';

/** Why a rollback left something as it was (CAN-7058). */
type RollbackLeftReason =
  | 'link_restore_retired'
  | 'asset_path_link'
  | 'staging_cleanup_failed';

const ROLLBACK_LEFT_MESSAGES: Record<RollbackLeftReason, string> = {
  link_restore_retired:
    '[pipeline-install] Left an installed file where a link used to be',
  asset_path_link:
    '[pipeline-install] Left a supporting file whose folder is a link or not a folder',
  staging_cleanup_failed:
    '[pipeline-install] Could not remove an install staging folder',
};

type AssetFileState =
  | { kind: 'absent' }
  | { kind: 'file'; sha256: string; mode: number; bytes: Buffer }
  | { kind: 'symlink'; target: string }
  | { kind: 'other' };

async function readAssetFile(file: string): Promise<AssetFileState> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(file);
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return { kind: 'absent' };
    throw error;
  }
  if (stats.isSymbolicLink())
    return { kind: 'symlink', target: await readlink(file) };
  if (!stats.isFile()) return { kind: 'other' };
  const bytes = await readFile(file);
  return {
    kind: 'file',
    sha256: sha256Of(bytes),
    mode: stats.mode & 0o777,
    bytes,
  };
}

function holdsPrevious(
  current: AssetFileState,
  previous: PreviousAssetFile | null,
): boolean {
  if (previous === null) return current.kind === 'absent';
  if (previous.kind === 'file')
    return current.kind === 'file' && current.sha256 === previous.sha256;
  return current.kind === 'symlink' && current.target === previous.target;
}

const INSTALL_TEMPORARY = /^(.+)\.[0-9a-f-]{36}\.tmp$/;
const DURABLE_INSTALL_TEMPORARY = /^\.(.+)\.[0-9]+\.[0-9a-f-]{36}\.tmp$/;

/** The fresh folder an asset install stages a file in, beside it (CAN-7058). */
const INSTALL_STAGING =
  /^\.install-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type DefinitionState =
  | { kind: 'absent' }
  | { kind: 'stored'; hash: string; revision: number }
  | { kind: 'unlisted'; hash: string };

/**
 * Where a run of a definition stands against install recovery and the
 * installs of this process. `installing` means an install still covers it.
 */
export type PipelineDefinitionRecovery =
  | 'ready'
  | 'restoring'
  | 'installing'
  | 'unconfirmed'
  | 'removed';

type SettledRecovery = 'ready' | 'unconfirmed' | 'removed';

/** How an install of this process ended, for the runs waiting on it. */
type LiveInstallEnd = 'finished' | 'undone' | 'unconfirmed';

type SettleRecovery = (
  outcome: 'ready' | 'unconfirmed',
  removed: ReadonlySet<string>,
) => void;

/** How long a run start waits for its definition's rollback (CAN-7308). */
export const RUN_START_RECOVERY_WAIT_MS = 60_000;

/**
 * How long a run start waits for an install of this process that covers its
 * definition (CAN-7359). An install records each file and, for shared
 * installs, its receipt with the cloud, so it can take minutes.
 */
export const LIVE_INSTALL_WAIT_MS = 300_000;

// Shown under "Couldn't start <workflow>". The rollback is still running, so
// starting again shortly can work.
export const PIPELINE_DEFINITION_RESTORING_MESSAGE =
  "An update to this workflow didn't finish and is still being undone. Try again in a moment.";
// The rollback failed; its record stays, and the next start retries it.
// There's no Try again: starting again before a restart can't fix it.
export const PIPELINE_DEFINITION_UNCONFIRMED_MESSAGE =
  "An update to this workflow didn't finish and couldn't be undone. Restart the app to try again.";
// The rollback removed a workflow the interrupted install had added. Reuses
// the existing not-found copy (automations, Remote Control).
export const PIPELINE_DEFINITION_REMOVED_MESSAGE = 'Workflow not found.';
// An install is still writing the workflow, so starting again once it
// finishes can work.
export const PIPELINE_DEFINITION_INSTALLING_MESSAGE =
  "Couldn't start this workflow because it's still being installed. Try again once the install finishes.";

export interface PipelineDefinitionRecoveryRefusal {
  error: string;
  errorCode:
    | 'pipeline_definition_restoring'
    | 'pipeline_definition_installing'
    | 'pipeline_definition_unconfirmed'
    | 'pipeline_definition_removed';
}

export interface PipelineInstallJournalIntent<
  TReceipt,
  TNextRecord extends PipelineInstallJournalRecord,
> {
  /**
   * Before saving `definitionId`: a `created` id must be new, a `replaced`
   * definition's current document is kept for rollback, and a `linked` one
   * is left as it is while its records change.
   */
  noteDefinition(input: {
    definitionId: string;
    change: 'created' | 'replaced' | 'linked';
    contentHash: string;
    assets?: true;
  }): Promise<void>;
  /**
   * Before writing a definition's supporting files: keeps a copy of every
   * file the plan overwrites, then notes each file, the folders it creates
   * and `assets.json`. A created definition overwrites nothing, so nothing is
   * kept for it, but its notes let a rollback that keeps a later edit of its
   * document still remove the files the install wrote (CAN-7364).
   */
  noteAssetFiles(
    definitionId: string,
    plan: PipelineAssetInstallPlan,
  ): Promise<void>;
  /** Before writing (or, with `null`, removing) the definition's record. */
  noteInstallRecord(
    definitionId: string,
    next: TNextRecord | null,
  ): Promise<void>;
  /** Before recording `receipt` for the definition. */
  noteReceipt(
    definitionId: string,
    effect: {
      accountId: string;
      receipt: TReceipt;
      previous: TReceipt | undefined;
    },
  ): Promise<void>;
  /** Commit the install and retain any pending marker clears for recovery. */
  finish(
    markerClears?: readonly CommittedMarkerClear[],
    subscription?: CommittedPipelineSubscription,
  ): Promise<void>;
  /**
   * The install failed: undo what is left of it after the caller's own
   * rollback, then drop the record. When an undo fails the record stays for
   * startup recovery and this rejects.
   */
  rollBack(): Promise<void>;
}

/** A host's install journal: what {@link createPipelineInstallJournal} returns. */
export interface PipelineInstallJournal<
  TReceipt,
  TNextRecord extends PipelineInstallJournalRecord,
> {
  readonly recoverInterruptedPipelineInstalls: (options?: {
    onListed?: () => void;
  }) => Promise<void>;
  readonly isPipelineDefinitionClaimed: (definitionId: string) => boolean;
  readonly whenPipelineInstallsRecovered: () => Promise<void>;
  readonly whenPipelineDefinitionRecovered: (
    definitionId: string,
    waitMs?: number,
  ) => Promise<PipelineDefinitionRecovery>;
  readonly pipelineDefinitionRecoveryRefusal: (
    definitionId: string,
  ) => Promise<PipelineDefinitionRecoveryRefusal | null>;
  readonly beginPipelineInstallIntent: (
    source: PipelineInstallIntentSource,
  ) => Promise<PipelineInstallJournalIntent<TReceipt, TNextRecord>>;
}

/**
 * The install journal over `environment`, one per host (CAN-7058). Its
 * claims and recovery state belong to this instance. `TRecord` is the record
 * kept for rollback, `TNextRecord` the one an install notes it writes.
 */
export function createPipelineInstallJournal<
  TReceipt,
  TRecord extends PipelineInstallJournalRecord,
  TNextRecord extends PipelineInstallJournalRecord,
>(
  environment: PipelineInstallJournalEnvironment<TReceipt, TRecord>,
): PipelineInstallJournal<TReceipt, TNextRecord> {
  type InstallReceipt = TReceipt;
  type CapabilityPackageInstallRecordV1 = TRecord;
  type PipelinePackageInstallRecordV1 = TNextRecord;
  type PipelineInstallIntent = PipelineInstallJournalIntent<
    TReceipt,
    TNextRecord
  >;
  type Environment = PipelineInstallJournalEnvironment<TReceipt, TRecord>;
  type InstallRecords = NonNullable<Environment['installRecords']>;
  const {
    getPipelineInstallIntentsDir,
    getDataDir,
    getPipelineAssetsDir,
    getPipelineAssetsManifestPath,
    assertWritable,
    createDirectoryDurably,
    syncDirectory,
    writeFileAtomically,
    writeStoreFileDurably,
    definitions: {
      inspectStoredPipelineDocument,
      removeUnlistedStoredPipelineDocument,
      removeStoredPipeline,
      writeStoredPipeline,
    },
    pipelineService: localPipelineService,
    deleteUserPipelineLocalMetadata,
    isInstallReceipt,
    noteDefinitionRemoved,
    definitionRemoval,
    warn: logMainProcessWarn,
    setTimeout,
    clearTimeout,
    removePath: rm,
    removeEmptyFolder: rmdir,
    renamePath: rename,
    makeFolder: mkdir,
    pruneDamagedCopies,
  } = environment;
  /** A store this host lacks: reaching it throws, leaving the record. */
  const lacking = (port: PipelineInstallJournalHostPort) => (): never => {
    throw new PipelineInstallJournalLeftForHostError(port);
  };
  const installRecords = environment.installRecords;
  const getPipelinePackageInstallStorePath: InstallRecords['storePath'] =
    installRecords?.storePath ?? lacking('install_records');
  const findCapabilityPackageInstallByOwner: InstallRecords['find'] =
    installRecords?.find ?? lacking('install_records');
  const upsertCapabilityPackageInstall: InstallRecords['upsert'] =
    installRecords?.upsert ?? lacking('install_records');
  const removeCapabilityPackageInstall: InstallRecords['remove'] =
    installRecords?.remove ?? lacking('install_records');
  const createResourceInstallReceiptsStore: NonNullable<
    Environment['installReceipts']
  > = environment.installReceipts ?? lacking('install_receipts');
  const recordSharedItemLocalUninstall: NonNullable<
    Environment['recordSharedItemLocalUninstall']
  > =
    environment.recordSharedItemLocalUninstall ?? lacking('shared_item_ledger');
  interface IntentDefinition {
    definitionId: string;
    /**
     * `created`: the install saves a new definition under an id nothing else
     * holds. `replaced`: it overwrites one, whose document is kept here.
     * `linked`: it leaves the document as it is and only changes its records.
     */
    change: 'created' | 'replaced' | 'linked';
    /** The document hash the install writes. */
    contentHash: string;
    previous?: ReplacedDefinition;
    /** Remove the definition's supporting files with it (automation installs). */
    assets?: true;
    /** Supporting files the install changed in the definition. */
    assetFiles?: IntentAssets;
    installRecord?: {
      previous: CapabilityPackageInstallRecordV1 | null;
      /** {@link installRecordIdentity} of what the install writes; null removes. */
      next: string | null;
    };
    receipt?: {
      accountId: string;
      receipt: InstallReceipt;
      previous: InstallReceipt | null;
    };
  }

  interface IntentFile {
    markerClears?: readonly CommittedMarkerClear[];
    subscription?: CommittedPipelineSubscription;
    id: string;
    source: PipelineInstallIntentSource;
    startedAt: string;
    definitions: IntentDefinition[];
  }

  function isInstallRecordOrNull(
    value: unknown,
  ): value is CapabilityPackageInstallRecordV1 | null {
    return (
      value === null ||
      (isRecord(value) &&
        isRecord(value.owner) &&
        typeof value.pipelineContentHash === 'string')
    );
  }

  function parseDefinition(value: unknown): IntentDefinition | null {
    if (
      !isRecord(value) ||
      typeof value.definitionId !== 'string' ||
      // A record naming any other id is unreadable, so it is set aside rather
      // than rolled back under a path the store would never write (CAN-7058).
      !STORED_PIPELINE_ID.test(value.definitionId) ||
      typeof value.contentHash !== 'string' ||
      (value.change !== 'created' &&
        value.change !== 'replaced' &&
        value.change !== 'linked')
    )
      return null;
    const definition: IntentDefinition = {
      definitionId: value.definitionId,
      change: value.change,
      contentHash: value.contentHash,
    };
    const previous = value.previous;
    if (previous !== undefined) {
      if (
        !isRecord(previous) ||
        typeof previous.text !== 'string' ||
        typeof previous.name !== 'string' ||
        typeof previous.description !== 'string' ||
        typeof previous.icon !== 'string'
      )
        return null;
      definition.previous = {
        text: previous.text,
        name: previous.name,
        description: previous.description,
        icon: previous.icon,
      };
    }
    if (definition.change === 'replaced' && !definition.previous) return null;
    if (value.assets === true) definition.assets = true;
    if (value.assetFiles !== undefined) {
      const assetFiles = parseIntentAssets(value.assetFiles);
      if (!assetFiles) return null;
      definition.assetFiles = assetFiles;
    }
    const installRecord = value.installRecord;
    if (installRecord !== undefined) {
      if (
        !isRecord(installRecord) ||
        !isInstallRecordOrNull(installRecord.previous) ||
        (installRecord.next !== null && typeof installRecord.next !== 'string')
      )
        return null;
      definition.installRecord = {
        previous: installRecord.previous,
        next: installRecord.next,
      };
    }
    const receipt = value.receipt;
    if (receipt !== undefined) {
      if (
        !isRecord(receipt) ||
        typeof receipt.accountId !== 'string' ||
        !isInstallReceipt(receipt.receipt) ||
        (receipt.previous !== null && !isInstallReceipt(receipt.previous))
      )
        return null;
      definition.receipt = {
        accountId: receipt.accountId,
        receipt: receipt.receipt,
        previous: receipt.previous,
      };
    }
    return definition;
  }

  type ParsedIntent =
    | { kind: 'intent'; intent: IntentFile }
    | { kind: 'newer' }
    | { kind: 'unreadable' };

  function parseIntentFile(text: string): ParsedIntent {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { kind: 'unreadable' };
    }
    if (!isRecord(value) || typeof value.version !== 'number')
      return { kind: 'unreadable' };
    if (value.version > INTENT_VERSION) return { kind: 'newer' };
    if (
      ![1, 2, 3, 4].includes(value.version) ||
      typeof value.id !== 'string' ||
      typeof value.startedAt !== 'string' ||
      (value.source !== 'shared' &&
        value.source !== 'curated' &&
        value.source !== 'package_share' &&
        value.source !== 'automation') ||
      !Array.isArray(value.definitions)
    )
      return { kind: 'unreadable' };
    const definitions: IntentDefinition[] = [];
    for (const entry of value.definitions) {
      const definition = parseDefinition(entry);
      if (!definition) return { kind: 'unreadable' };
      definitions.push(definition);
    }
    const markerClears: CommittedMarkerClear[] = [];
    if (value.version >= 3) {
      if (
        value.source === 'curated' ||
        !Array.isArray(value.markerClears) ||
        value.markerClears.length === 0
      )
        return { kind: 'unreadable' };
      const writtenIds = new Set(
        definitions
          .filter(({ change }) => change !== 'linked')
          .map(({ definitionId }) => definitionId),
      );
      for (const marker of value.markerClears) {
        if (
          !isRecord(marker) ||
          typeof marker.definitionId !== 'string' ||
          !writtenIds.delete(marker.definitionId) ||
          typeof marker.revision !== 'number' ||
          !Number.isSafeInteger(marker.revision) ||
          marker.revision <= 0
        )
          return { kind: 'unreadable' };
        markerClears.push({
          definitionId: marker.definitionId,
          revision: marker.revision,
        });
      }
      if (writtenIds.size > 0) return { kind: 'unreadable' };
    }
    let subscription: CommittedPipelineSubscription | undefined;
    if (value.version === 4) {
      const record = value.subscription;
      if (
        (value.source !== 'shared' && value.source !== 'package_share') ||
        !isRecord(record) ||
        typeof record.remoteId !== 'string' ||
        record.remoteId.trim() === '' ||
        typeof record.localId !== 'string' ||
        !markerClears.some(
          ({ definitionId }) => definitionId === record.localId,
        ) ||
        (record.sourceKind !== 'shared' && record.sourceKind !== 'public') ||
        (record.contentHash !== null &&
          typeof record.contentHash !== 'string') ||
        (record.observedLedgerVersion !== undefined &&
          record.observedLedgerVersion !== null &&
          typeof record.observedLedgerVersion !== 'string')
      )
        return { kind: 'unreadable' };
      subscription = {
        remoteId: record.remoteId,
        localId: record.localId,
        sourceKind: record.sourceKind,
        contentHash: record.contentHash,
        ...(record.observedLedgerVersion !== undefined && {
          observedLedgerVersion: record.observedLedgerVersion,
        }),
      };
    }
    return {
      kind: 'intent',
      intent: {
        id: value.id,
        source: value.source,
        startedAt: value.startedAt,
        definitions,
        ...(value.version >= 3 && { markerClears }),
        ...(subscription && { subscription }),
      },
    };
  }

  function intentPath(id: string): string {
    return path.join(getPipelineInstallIntentsDir(), `${id}.json`);
  }

  /** `<intents>/<id>/`: the supporting files the install replaced, by sha256. */
  function snapshotsDir(id: string): string {
    return path.join(getPipelineInstallIntentsDir(), id);
  }

  async function writeIntent(intent: IntentFile): Promise<void> {
    // The folder's own entry must survive power loss with the record, before
    // any write the record covers (CAN-5678).
    await createDirectoryDurably(getPipelineInstallIntentsDir(), {
      dataRoot: getDataDir(),
    });
    // Older hosts leave records with supporting files or committed clears
    // alone when they cannot settle them.
    const version = intent.subscription
      ? 4
      : intent.markerClears
        ? 3
        : intent.definitions.some((entry) => entry.assetFiles)
          ? 2
          : 1;
    await writeStoreFileDurably(
      intentPath(intent.id),
      `${JSON.stringify({ ...intent, version }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  }

  /**
   * Removes a finished or rolled-back record, then the files it kept. A
   * removal that may not survive power loss is logged: a record that
   * reappears only rolls back writes that still hold exactly what that
   * install wrote, so its kept files stay until the next start finds the
   * record gone. Kept files a failed removal leaves go then too.
   */
  async function removeIntent(id: string): Promise<void> {
    await rm(intentPath(id), { force: true });
    try {
      await syncDirectory(getPipelineInstallIntentsDir());
    } catch (error) {
      logMainProcessWarn(
        '[pipeline-install] Removed an install record, but its folder flush failed',
        error,
      );
      return;
    }
    await rm(snapshotsDir(id), { recursive: true, force: true }).catch(
      (error: unknown) => {
        logMainProcessWarn(
          '[pipeline-install] Could not remove the files an install kept',
          error,
        );
      },
    );
  }

  /** A supporting file's path, under the pipeline's asset dir. */
  function assetPath(definitionId: string, relativePath: string): string {
    const root = getPipelineAssetsDir(definitionId);
    return relativePath === '.'
      ? root
      : path.join(root, ...relativePath.split('/'));
  }

  /**
   * Checks the path down to `folder` as an install does before it writes
   * (CAN-7058): a rollback writes and removes only through real folders, so a
   * folder swapped for a link never sends a write or removal elsewhere.
   */
  async function folderChain(
    definitionId: string,
    folder: string,
  ): Promise<FolderChain> {
    const top = path.dirname(getPipelineAssetsDir(definitionId));
    const relative = path.relative(top, folder);
    if (
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      return 'refused';
    let current = top;
    for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
      if (segment) current = path.join(current, segment);
      let stats: Awaited<ReturnType<typeof lstat>>;
      try {
        stats = await lstat(current);
      } catch (error) {
        if (isRecord(error) && error.code === 'ENOENT') return 'missing';
        throw error;
      }
      if (stats.isSymbolicLink() || !stats.isDirectory()) return 'refused';
    }
    return 'real';
  }

  /**
   * Logs what a rollback left and why. Each is handled, not a failure: the
   * rest of the rollback goes on, and the record completes and releases what
   * it claimed, so it never blocks a reinstall.
   */
  function logRollbackLeft(
    reason: RollbackLeftReason,
    details: { definitionId: string; error?: unknown },
  ): void {
    logMainProcessWarn(ROLLBACK_LEFT_MESSAGES[reason], { reason, ...details });
  }

  /**
   * True when a rollback may write or remove inside `folder`. A refusal is
   * logged with the definition id only, never a path; a missing folder holds
   * nothing to undo.
   */
  async function mayChange(
    definitionId: string,
    folder: string,
  ): Promise<boolean> {
    const chain = await folderChain(definitionId, folder);
    if (chain === 'refused')
      logRollbackLeft('asset_path_link', { definitionId });
    return chain === 'real';
  }

  /** Puts back what a supporting file held before the install wrote it. */
  async function restoreAssetFile(
    intentId: string,
    definitionId: string,
    target: string,
    previous: PreviousAssetFile | null,
  ): Promise<void> {
    if (previous === null) {
      await rm(target, { force: true });
      return;
    }
    if (previous.kind === 'file') {
      const bytes = await readFile(
        path.join(snapshotsDir(intentId), previous.sha256),
      );
      if (sha256Of(bytes) !== previous.sha256)
        throw new Error(`The kept copy of ${target} does not match its hash`);
      await writeFileAtomically(target, bytes, {
        mode: previous.mode,
        durable: true,
      });
      return;
    }
    // A link is never recreated in the asset dir (CAN-7058): installs refuse
    // to write through or over one, so only an older record can hold one. The
    // installed file stays and the rest of the install rolls back. An older
    // record that kept a link still parses; it is only never acted on.
    logRollbackLeft('link_restore_retired', { definitionId });
  }

  /**
   * Removes legacy `<name>.<uuid>.tmp` and durable `.<name>.<pid>.<uuid>.tmp`
   * files written before renaming over `targets`: an exit leaves one behind.
   */
  async function removeInstallTemporaries(
    definitionId: string,
    targets: readonly string[],
  ): Promise<void> {
    const names = new Map<string, Set<string>>();
    for (const target of targets) {
      const folder = path.dirname(target);
      const inFolder = names.get(folder) ?? new Set<string>();
      inFolder.add(path.basename(target));
      names.set(folder, inFolder);
    }
    for (const [folder, inFolder] of names) {
      if (!(await mayChange(definitionId, folder))) continue;
      let entries: string[];
      try {
        entries = await readdir(folder);
      } catch (error) {
        if (isRecord(error) && error.code === 'ENOENT') continue;
        throw error;
      }
      for (const entry of entries) {
        const name = INSTALL_TEMPORARY.exec(entry)?.[1];
        const durableName = DURABLE_INSTALL_TEMPORARY.exec(entry)?.[1];
        if (
          (name !== undefined && inFolder.has(name)) ||
          (durableName !== undefined && inFolder.has(durableName))
        )
          await rm(path.join(folder, entry), { force: true });
      }
    }
  }

  /**
   * Removes the staging folders an exit left: only the folder named `staging`,
   * the name this install recorded, only in the folders the record's own files
   * live in, only through real folders, and only when it is a real folder. A
   * staging-shaped folder of another name is never this install's. `rm`
   * removes a link inside one as a link, never what it points to. A failure is
   * logged and the rollback goes on: a staging folder holds nothing the
   * install placed.
   */
  async function removeInstallStaging(
    definitionId: string,
    files: readonly string[],
    staging: string,
  ): Promise<void> {
    const folders = new Set(files.map((file) => path.dirname(file)));
    for (const folder of folders) {
      try {
        if (!(await mayChange(definitionId, folder))) continue;
        const target = path.join(folder, staging);
        let stats: Awaited<ReturnType<typeof lstat>>;
        try {
          stats = await lstat(target);
        } catch (error) {
          if (isRecord(error) && error.code === 'ENOENT') continue;
          throw error;
        }
        if (stats.isSymbolicLink() || !stats.isDirectory()) continue;
        await rm(target, { recursive: true, force: true });
        await syncDirectory(folder);
      } catch (error) {
        logRollbackLeft('staging_cleanup_failed', { definitionId, error });
      }
    }
  }

  /** Flushes a folder the rollback changed, when it is there and real. */
  async function flushFolder(
    definitionId: string,
    folder: string,
  ): Promise<void> {
    if ((await folderChain(definitionId, folder)) === 'real')
      await syncDirectory(folder);
  }

  async function removeEmptyFolder(
    definitionId: string,
    folder: string,
  ): Promise<void> {
    if (!(await mayChange(definitionId, folder))) return;
    try {
      await rmdir(folder);
    } catch (error) {
      const code = isRecord(error) ? error.code : undefined;
      // A folder that holds anything, including a later file, stays.
      if (
        code === 'ENOENT' ||
        code === 'ENOTEMPTY' ||
        code === 'EEXIST' ||
        code === 'ENOTDIR'
      )
        return;
      throw error;
    }
  }

  /**
   * Undoes the supporting files an install changed in a definition that
   * stays: a file is put back only while it holds what the install wrote,
   * `assets.json` likewise, and a folder the install created goes only while
   * it is empty. A later edit stays. Nothing is written or removed through a
   * folder that is a link or not a folder (CAN-7058).
   */
  async function undoAssetFiles(
    intentId: string,
    definition: IntentDefinition,
  ): Promise<void> {
    const assets = definition.assetFiles;
    if (!assets) return;
    const id = definition.definitionId;
    // Staging folders are the install's own, whatever happened to the rest.
    // They go here, before the record does, so an exit between the two leaves
    // a record the next start finishes.
    if (assets.staging !== undefined)
      await removeInstallStaging(
        id,
        assets.files.map((file) => assetPath(id, file.path)),
        assets.staging,
      );
    // Also when the document was edited since (CAN-7364): each file below
    // goes back only while it holds exactly what the install wrote.
    const manifestPath = getPipelineAssetsManifestPath(id);
    // Every path below is inside the pipeline's data folder.
    if (!(await mayChange(id, path.dirname(manifestPath)))) return;
    await removeInstallTemporaries(id, [
      ...assets.files.map((file) => assetPath(id, file.path)),
      manifestPath,
    ]);
    for (const file of [...assets.files].reverse()) {
      const target = assetPath(id, file.path);
      if (!(await mayChange(id, path.dirname(target)))) continue;
      const current = await readAssetFile(target);
      if (holdsPrevious(current, file.previous)) {
        // Rewritten with the same bytes, the file may still have changed mode.
        if (
          current.kind === 'file' &&
          file.previous?.kind === 'file' &&
          current.sha256 === file.next &&
          current.mode !== file.previous.mode
        )
          await writeFileAtomically(target, current.bytes, {
            mode: file.previous.mode,
            durable: true,
          });
        continue;
      }
      if (current.kind !== 'file' || current.sha256 !== file.next) continue;
      await restoreAssetFile(intentId, id, target, file.previous);
    }
    const manifest = await readAssetFile(manifestPath);
    if (manifest.kind === 'file' && manifest.sha256 === assets.manifest.next) {
      if (assets.manifest.previous === null)
        await rm(manifestPath, { force: true });
      else
        await writeFileAtomically(manifestPath, assets.manifest.previous, {
          durable: true,
        });
    }
    for (const folder of [...assets.createdDirectories].reverse())
      await removeEmptyFolder(id, assetPath(id, folder));
    // A removal, rename or folder removal persists only with its folder, so
    // each is flushed before the record and its kept copies can go.
    const folders = new Set<string>([path.dirname(manifestPath)]);
    for (const file of assets.files)
      folders.add(path.dirname(assetPath(id, file.path)));
    for (const folder of assets.createdDirectories)
      folders.add(path.dirname(assetPath(id, folder)));
    for (const folder of folders) await flushFolder(id, folder);
  }

  function readDefinition(definitionId: string): DefinitionState {
    const state = inspectStoredPipelineDocument(definitionId);
    if (state.kind === 'unreadable') throw new Error(state.message);
    if (state.kind === 'absent') return state;
    const hash = hashPipelinePackageYaml(state.rawContent);
    return state.kind === 'stored'
      ? { kind: 'stored', hash, revision: state.revision }
      : { kind: 'unlisted', hash };
  }

  /**
   * What makes two install records the same install, whatever their key order
   * or install time.
   */
  function installRecordIdentity(
    record: CapabilityPackageInstallRecordV1 | PipelinePackageInstallRecordV1,
  ): string {
    return JSON.stringify([
      record.pipelineContentHash,
      record.distributionMode === 'definition_only'
        ? 'definition_only'
        : 'package',
      record.packageDigest ?? null,
      record.originExternalId ?? null,
      'localContentHash' in record ? (record.localContentHash ?? null) : null,
    ]);
  }

  function identityOf(
    record: CapabilityPackageInstallRecordV1 | null,
  ): string | null {
    return record === null ? null : installRecordIdentity(record);
  }

  /** The supporting files of an automation pipeline the install created. */
  async function removeCreatedAssets(
    definition: IntentDefinition,
  ): Promise<void> {
    if (!definition.assets) return;
    const id = definition.definitionId;
    const folder = path.dirname(getPipelineAssetsManifestPath(id));
    // Only through a real data folder (CAN-7058); `rm` removes an asset dir
    // that is a link as a link.
    if (!(await mayChange(id, folder))) return;
    await rm(getPipelineAssetsDir(id), { recursive: true, force: true });
    await rm(getPipelineAssetsManifestPath(id), { force: true });
    // Flushed before the record goes, so power loss cannot bring them back
    // with nothing left to remove them (CAN-5678).
    await flushFolder(id, folder);
  }

  /**
   * Undoes one definition's document. `removed` when this rollback deleted a
   * copy the install created, `undone` when it otherwise no longer holds what
   * the install wrote, `edited` when it holds content nobody can attribute to
   * the install (a later edit), which keeps its records and receipt with it,
   * and `kept` when another install adopted the copy.
   */
  async function undoDefinition(
    definition: IntentDefinition,
  ): Promise<'removed' | 'undone' | 'edited' | 'kept'> {
    const id = definition.definitionId;
    if (definition.change === 'linked') return 'undone';
    const state = readDefinition(id);
    if (definition.change === 'created') {
      // Its metadata and supporting files go whenever the copy does, also
      // when an earlier rollback removed the copy and exited before them.
      if (state.kind === 'absent') {
        deleteUserPipelineLocalMetadata(id);
        await removeCreatedAssets(definition);
        return 'undone';
      }
      if (state.hash !== definition.contentHash) return 'edited';
      if (state.kind === 'unlisted') {
        const removed = removeUnlistedStoredPipelineDocument(
          id,
          definition.contentHash,
        );
        if (!removed.ok) throw new Error(removed.message);
        await removeCreatedAssets(definition);
        return 'undone';
      }
      // Another install that adopted the copy and recorded it keeps it.
      const record = identityOf(
        await findCapabilityPackageInstallByOwner(
          getPipelinePackageInstallStorePath(),
          { kind: 'pipeline', localPipelineId: id },
        ),
      );
      if (
        record !== null &&
        record !== (definition.installRecord?.next ?? null)
      )
        return 'kept';
      const current = inspectStoredPipelineDocument(id);
      if (
        current.kind !== 'stored' ||
        hashPipelinePackageYaml(current.rawContent) !== definition.contentHash
      )
        return 'edited';
      const removed = removeStoredPipeline(id, {
        expectedRevision: current.revision,
      });
      if (!removed.ok) {
        if (removed.reason === 'revision_conflict') return 'edited';
        throw new Error(removed.message);
      }
      deleteUserPipelineLocalMetadata(id);
      await removeCreatedAssets(definition);
      return 'removed';
    }
    const previous = definition.previous;
    if (!previous) return 'kept';
    if (state.kind !== 'stored') return 'edited';
    if (state.hash === hashPipelinePackageYaml(previous.text)) return 'undone';
    if (state.hash !== definition.contentHash) return 'edited';
    const current = inspectStoredPipelineDocument(id);
    if (
      current.kind !== 'stored' ||
      hashPipelinePackageYaml(current.rawContent) !== definition.contentHash
    )
      return 'edited';
    const restored = writeStoredPipeline(
      {
        id,
        name: previous.name,
        description: previous.description,
        icon: previous.icon,
        content: parsePipelineText(previous.text),
        rawContent: previous.text,
      },
      { expectedRevision: current.revision, requireExisting: true },
    );
    if (!restored.ok) {
      if (restored.reason === 'revision_conflict') return 'edited';
      throw new Error(restored.message);
    }
    return 'undone';
  }

  async function undoInstallRecord(
    definition: IntentDefinition,
  ): Promise<void> {
    const effect = definition.installRecord;
    if (!effect) return;
    const storePath = getPipelinePackageInstallStorePath();
    const owner = {
      kind: 'pipeline' as const,
      localPipelineId: definition.definitionId,
    };
    const current = identityOf(
      await findCapabilityPackageInstallByOwner(storePath, owner),
    );
    // A created definition's id was new, so any record it has is this install's.
    if (definition.change !== 'created' && current !== effect.next) return;
    if (current === identityOf(effect.previous)) return;
    if (effect.previous && definition.change !== 'created')
      await upsertCapabilityPackageInstall(storePath, effect.previous);
    else await removeCapabilityPackageInstall(storePath, owner);
  }

  /**
   * The store a record needs that this host lacks, if any: its receipt, its
   * install record, or, for a definition it created, the install records
   * that tell whether another install adopted it and the ledger its removal
   * reaches.
   */
  function lackingPortFor(
    intent: IntentFile,
  ): PipelineInstallJournalHostPort | null {
    for (const definition of intent.definitions) {
      if (definition.receipt && !environment.installReceipts)
        return 'install_receipts';
      if (definition.installRecord && !installRecords) return 'install_records';
      if (definition.change === 'created') {
        if (!environment.recordSharedItemLocalUninstall)
          return 'shared_item_ledger';
        if (!installRecords) return 'install_records';
      }
    }
    return null;
  }

  async function finalizeCommittedIntent(
    id: string,
    markerClears: readonly CommittedMarkerClear[],
    subscription: CommittedPipelineSubscription | undefined,
    recovery: 'live' | 'replay',
  ): Promise<void> {
    await assertWritable();
    const clearMarker = environment.clearInstalledPipelineMarker;
    if (!clearMarker)
      throw new PipelineInstallJournalLeftForHostError('agent_markers');
    // The journal writer can return after a rename with an unconfirmed flush.
    await syncDirectory(getPipelineInstallIntentsDir());
    for (const marker of markerClears) clearMarker(marker);
    if (subscription) {
      const record = environment.recordCommittedSubscription;
      if (!record)
        throw new PipelineInstallJournalLeftForHostError('shared_item_ledger');
      const stored = inspectStoredPipelineDocument(subscription.localId);
      if (stored.kind === 'unreadable')
        throw new Error('The installed workflow could not be confirmed.');
      if (stored.kind === 'stored') await record(subscription, recovery);
    }
    await removeIntent(id);
  }

  async function rollBackIntent(intent: IntentFile): Promise<void> {
    await assertWritable();
    const lackingPort = lackingPortFor(intent);
    if (lackingPort) {
      logMainProcessWarn(
        '[pipeline-install] Left an install record for a host that can undo it',
        { reason: 'needs_host_port', port: lackingPort, intentId: intent.id },
      );
      throw new PipelineInstallJournalLeftForHostError(lackingPort);
    }
    const failures: string[] = [];
    const undone: Array<{ definition: IntentDefinition; removed: boolean }> =
      [];
    for (const definition of [...intent.definitions].reverse()) {
      try {
        const outcome = await undoDefinition(definition);
        if (outcome === 'kept') continue;
        if (outcome === 'edited') {
          // The edit, its record and its receipt stay; the files the install
          // wrote go back while nobody has changed them since (CAN-7364).
          await undoAssetFiles(intent.id, definition);
          continue;
        }
        // Files first, so the earlier record never names files it lacks.
        await undoAssetFiles(intent.id, definition);
        await undoInstallRecord(definition);
        undone.push({ definition, removed: outcome === 'removed' });
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    // Provenance goes last, and only with the definitions it describes: a
    // definition that could not be undone keeps its receipt.
    if (failures.length === 0) {
      for (const { definition, removed } of undone) {
        try {
          const effect = definition.receipt;
          if (effect)
            await createResourceInstallReceiptsStore(
              effect.accountId,
            ).rollbackInstall(effect.receipt, effect.previous ?? undefined);
          // Only a copy this rollback removed can have reached the ledger.
          if (removed)
            recordSharedItemLocalUninstall({
              kind: 'pipeline',
              localId: definition.definitionId,
            });
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
    if (failures.length > 0)
      throw new Error(
        `Could not roll back an interrupted workflow install: ${failures.join('; ')}`,
      );
    await removeIntent(intent.id);
  }

  /**
   * Keeps the newest five set-aside records, and the set-aside kept files of
   * only those records.
   */
  async function pruneSetAsideRecords(): Promise<void> {
    const directory = getPipelineInstallIntentsDir();
    await pruneDamagedCopies({ directory, prefix: UNREADABLE_INTENT_PREFIX });
    const names = await readdir(directory).catch((): string[] => []);
    for (const name of names) {
      const match = UNREADABLE_SNAPSHOTS.exec(name);
      if (match && !names.includes(`${match[1]}.json${match[2]}`))
        await rm(path.join(directory, name), {
          recursive: true,
          force: true,
        }).catch(() => undefined);
    }
  }

  /**
   * Rolls back every install an earlier process left unfinished. Runs before
   * any install of this process starts ({@link whenPipelineInstallsRecovered}),
   * so every record it finds is an earlier process's. A record from a newer
   * version is left for that version; an unreadable one is set aside as
   * `.unreadable-<ms>`, with its kept files, so it is never read as an install
   * again; only the newest five set-aside records are kept. One install's
   * failure does not stop the others; it stays for the next start.
   *
   * Every record is read before any is rolled back, so a run start learns
   * which definitions are being restored ({@link whenPipelineDefinitionRecovered})
   * without waiting for an unrelated rollback. `onListed` runs once they are.
   */
  async function recoverInterruptedPipelineInstalls(
    options: { onListed?: () => void } = {},
  ): Promise<void> {
    // A host the intents' owner record refuses still reads them, writing
    // nothing: what they cover stays claimed and unconfirmed, so no run starts
    // against it, and the refusal is thrown once they are read.
    const refusal = await Promise.resolve()
      .then(assertWritable)
      .then(
        () => undefined,
        (error: unknown) =>
          error instanceof Error ? error : new Error(String(error)),
      );
    let names: string[];
    try {
      names = await readdir(getPipelineInstallIntentsDir());
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') {
        if (refusal) throw refusal;
        return;
      }
      throw error;
    }
    const pending: Array<{ intent: IntentFile; settle: SettleRecovery }> = [];
    for (const name of names.sort()) {
      if (!INTENT_FILE.test(name)) continue;
      const id = name.slice(0, -'.json'.length);
      const file = intentPath(id);
      try {
        const parsed = parseIntentFile(await readFile(file, 'utf8'));
        if (parsed.kind === 'newer') {
          logMainProcessWarn(
            '[pipeline-install] Left an install record from a newer version',
            { id },
          );
          continue;
        }
        if (parsed.kind === 'unreadable' || parsed.intent.id !== id) {
          if (refusal) continue;
          const setAside = `.unreadable-${Date.now()}`;
          await rename(file, `${file}${setAside}`);
          await rename(
            snapshotsDir(id),
            `${snapshotsDir(id)}${setAside}`,
          ).catch((error: unknown) => {
            if (!isRecord(error) || error.code !== 'ENOENT') throw error;
          });
          await pruneSetAsideRecords();
          logMainProcessWarn(
            '[pipeline-install] Set aside an unreadable install record',
            { id },
          );
          continue;
        }
        if (refusal) {
          claimDefinitions(parsed.intent);
          unconfirmedIntents.add(parsed.intent.id);
          continue;
        }
        pending.push({
          intent: parsed.intent,
          settle: noteDefinitionsRecovering(parsed.intent),
        });
      } catch (error) {
        logMainProcessWarn(
          '[pipeline-install] Could not recover an interrupted install',
          error,
        );
      }
    }
    options.onListed?.();
    if (refusal) throw refusal;
    for (const { intent, settle } of pending) {
      try {
        if (intent.markerClears) {
          await finalizeCommittedIntent(
            intent.id,
            intent.markerClears,
            intent.subscription,
            'replay',
          );
        } else {
          await rollBackIntent(intent);
        }
        releaseClaims(intent.id);
        unconfirmedIntents.delete(intent.id);
        settle(
          'ready',
          intent.markerClears ? new Set() : noteUndoneDefinitions(intent),
        );
      } catch (error) {
        // Its record stays for the next start; until then no install of this
        // process may take over what it covers, and no run starts against it.
        claimDefinitions(intent);
        unconfirmedIntents.add(intent.id);
        settle('unconfirmed', new Set());
        logMainProcessWarn(
          '[pipeline-install] Could not recover an interrupted install',
          error,
        );
      }
    }
    // Files kept by an install whose record is gone: its removal exited
    // between the two.
    for (const name of names) {
      if (!INTENT_ID.test(name) || names.includes(`${name}.json`)) continue;
      await rm(snapshotsDir(name), { recursive: true, force: true }).catch(
        (error: unknown) => {
          logMainProcessWarn(
            '[pipeline-install] Could not remove the files an install kept',
            error,
          );
        },
      );
    }
  }

  /**
   * Definitions an unfinished install covers, by the intent that covers them:
   * every definition a live install noted, and every definition of a record
   * whose rollback failed, until that record is cleared. One install at a time
   * changes a definition, so a rollback only ever undoes its own writes.
   */
  const claimedDefinitions = new Map<string, string>();

  function claimDefinitions(intent: IntentFile): void {
    for (const definition of intent.definitions)
      claimedDefinitions.set(definition.definitionId, intent.id);
  }

  function releaseClaims(intentId: string): void {
    for (const [definitionId, owner] of Array.from(claimedDefinitions))
      if (owner === intentId) claimedDefinitions.delete(definitionId);
  }

  /** How each install of this process ends, until it has (CAN-7359). */
  const liveInstalls = new Map<string, Promise<LiveInstallEnd>>();

  /** The end of the install of this process that covers the definition. */
  function liveInstallOf(
    definitionId: string,
  ): Promise<LiveInstallEnd> | undefined {
    const owner = claimedDefinitions.get(definitionId);
    return owner === undefined ? undefined : liveInstalls.get(owner);
  }

  /**
   * After an intent is undone, notes each of its definitions the store no
   * longer has: one the install had created. A run must not fall back to a
   * caller's copy of it.
   */
  function noteUndoneDefinitions(intent: IntentFile): Set<string> {
    const removed = new Set<string>();
    for (const { definitionId } of intent.definitions)
      if (inspectStoredPipelineDocument(definitionId).kind === 'absent') {
        removed.add(definitionId);
        noteDefinitionRemoved(definitionId, 'undone');
      }
    return removed;
  }

  /**
   * True while an unfinished install covers the definition. Another install
   * must not adopt or change it: that install's rollback could undo its work.
   */
  function isPipelineDefinitionClaimed(definitionId: string): boolean {
    return claimedDefinitions.has(definitionId);
  }

  /**
   * Intents that could not finish recovery in this process. They stay for
   * the next start, and runs against the definitions they cover stay fenced.
   */
  const unconfirmedIntents = new Set<string>();

  /** Each definition startup recovery covers until its record settles. */
  const recoveringDefinitions = new Map<string, Promise<SettledRecovery>>();

  function noteDefinitionsRecovering(intent: IntentFile): SettleRecovery {
    let settle: SettleRecovery = () => undefined;
    const settled = new Promise<{
      outcome: 'ready' | 'unconfirmed';
      removed: ReadonlySet<string>;
    }>((resolve) => {
      settle = (outcome, removed): void => resolve({ outcome, removed });
    });
    for (const { definitionId } of intent.definitions) {
      const own: Promise<SettledRecovery> = settled.then(
        ({ outcome, removed }) =>
          outcome === 'unconfirmed'
            ? 'unconfirmed'
            : removed.has(definitionId)
              ? 'removed'
              : 'ready',
      );
      const earlier = recoveringDefinitions.get(definitionId);
      // A definition two records cover settles once both have; the later
      // record's rollback decides, unless either failed.
      const outcome = earlier
        ? Promise.all([earlier, own]).then(([first, last]) =>
            first === 'unconfirmed' ? 'unconfirmed' : last,
          )
        : own;
      recoveringDefinitions.set(definitionId, outcome);
      void outcome.then(() => {
        if (recoveringDefinitions.get(definitionId) === outcome)
          recoveringDefinitions.delete(definitionId);
      });
    }
    return settle;
  }

  let recovery: Promise<void> | undefined;
  let listed: Promise<void> = Promise.resolve();

  /**
   * Startup recovery, run once per process. Every install waits for it, so a
   * reinstall never runs beside the rollback of the attempt it repeats.
   */
  function whenPipelineInstallsRecovered(): Promise<void> {
    if (recovery) return recovery;
    let markListed: () => void = () => undefined;
    listed = new Promise<void>((resolve) => {
      markListed = resolve;
    });
    recovery = recoverInterruptedPipelineInstalls({ onListed: markListed })
      .catch((error: unknown) => {
        logMainProcessWarn(
          '[pipeline-install] Install recovery did not finish',
          error,
        );
      })
      .finally(markListed);
    return recovery;
  }

  async function definitionRecovery(
    definitionId: string,
    onLiveInstall: () => void,
  ): Promise<SettledRecovery> {
    await listed;
    const pending = recoveringDefinitions.get(definitionId);
    if (pending) {
      logMainProcessWarn(
        '[pipeline-install] A run is waiting for an interrupted update to be undone',
        { definitionId },
      );
      return pending;
    }
    if (definitionRemoval(definitionId) === 'undone') return 'removed';
    let live = liveInstallOf(definitionId);
    if (live) {
      onLiveInstall();
      logMainProcessWarn(
        '[pipeline-install] A run is waiting for an install of its workflow to finish',
        { definitionId },
      );
      for (; live; live = liveInstallOf(definitionId))
        if ((await live) === 'unconfirmed') return 'unconfirmed';
      if (definitionRemoval(definitionId) === 'undone') return 'removed';
    }
    const owner = claimedDefinitions.get(definitionId);
    return owner !== undefined && unconfirmedIntents.has(owner)
      ? 'unconfirmed'
      : 'ready';
  }

  /**
   * Whether a run may start against `definitionId`. It starts install recovery
   * if nothing has yet, then waits for the definition's rollback, up to
   * `waitMs`. A definition no record covers is `ready` once the records are
   * read. `restoring` means its rollback is still running; `unconfirmed` that
   * it failed in this process and the definition is only partly restored;
   * `removed` that the rollback removed a definition the install had created.
   * A definition an install of this process covers waits for that install,
   * up to {@link LIVE_INSTALL_WAIT_MS}, and is `installing` after that.
   */
  function whenPipelineDefinitionRecovered(
    definitionId: string,
    waitMs: number = RUN_START_RECOVERY_WAIT_MS,
  ): Promise<PipelineDefinitionRecovery> {
    void whenPipelineInstallsRecovered();
    return new Promise<PipelineDefinitionRecovery>((resolve) => {
      const waitFor = (
        ms: number,
        outcome: 'restoring' | 'installing',
      ): NodeJS.Timeout => {
        const timer = setTimeout(() => resolve(outcome), ms);
        timer.unref();
        return timer;
      };
      let timer = waitFor(waitMs, 'restoring');
      void definitionRecovery(definitionId, () => {
        clearTimeout(timer);
        timer = waitFor(LIVE_INSTALL_WAIT_MS, 'installing');
      }).then((outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      });
    });
  }

  /**
   * Every run start's wait for its definition (CAN-7308): `null` once a run
   * may read it, else why it can't start. Callers that read the definition
   * before starting the run wait here before that read.
   */
  async function pipelineDefinitionRecoveryRefusal(
    definitionId: string,
  ): Promise<PipelineDefinitionRecoveryRefusal | null> {
    const outcome = await whenPipelineDefinitionRecovered(definitionId);
    switch (outcome) {
      case 'ready':
        return null;
      case 'restoring':
        return {
          error: PIPELINE_DEFINITION_RESTORING_MESSAGE,
          errorCode: 'pipeline_definition_restoring',
        };
      case 'installing':
        return {
          error: PIPELINE_DEFINITION_INSTALLING_MESSAGE,
          errorCode: 'pipeline_definition_installing',
        };
      case 'unconfirmed':
        return {
          error: PIPELINE_DEFINITION_UNCONFIRMED_MESSAGE,
          errorCode: 'pipeline_definition_unconfirmed',
        };
      case 'removed':
        return {
          error: PIPELINE_DEFINITION_REMOVED_MESSAGE,
          errorCode: 'pipeline_definition_removed',
        };
    }
  }

  /** Starts an install's record; nothing is written until its first note. */
  async function beginPipelineInstallIntent(
    source: PipelineInstallIntentSource,
  ): Promise<PipelineInstallIntent> {
    await whenPipelineInstallsRecovered();
    await assertWritable();
    const intent: IntentFile = {
      id: randomUUID(),
      source,
      startedAt: new Date().toISOString(),
      definitions: [],
    };
    let written = false;
    // Runs of what it covers wait for this end (CAN-7359).
    let end: (how: LiveInstallEnd) => void = () => undefined;
    liveInstalls.set(
      intent.id,
      new Promise<LiveInstallEnd>((resolve) => {
        end = resolve;
      }),
    );
    const ended = (how: LiveInstallEnd): void => {
      liveInstalls.delete(intent.id);
      end(how);
    };
    const save = async (): Promise<void> => {
      await assertWritable();
      await writeIntent(intent);
      written = true;
    };
    const definitionFor = (definitionId: string): IntentDefinition => {
      const definition = intent.definitions.find(
        (entry) => entry.definitionId === definitionId,
      );
      if (!definition)
        throw new Error(`Install intent has no definition ${definitionId}`);
      return definition;
    };
    const release = (): void => {
      releaseClaims(intent.id);
    };
    // A finish or rollback the store's owner record refuses leaves the
    // intent for the owning host's recovery, so what it covers stays claimed
    // and no run starts against it.
    const leftForOwner = (error: unknown): never => {
      unconfirmedIntents.add(intent.id);
      ended('unconfirmed');
      throw error;
    };
    const settle = async (): Promise<void> => {
      if (written)
        await Promise.resolve().then(assertWritable).catch(leftForOwner);
      try {
        if (written) await removeIntent(intent.id);
        written = false;
        release();
      } finally {
        ended('finished');
      }
    };
    return {
      async noteDefinition(input): Promise<void> {
        if (
          intent.definitions.some(
            (entry) => entry.definitionId === input.definitionId,
          )
        )
          throw new Error(`Install intent already has ${input.definitionId}`);
        if (claimedDefinitions.has(input.definitionId))
          throw new Error(
            'Another install is changing this workflow. Try again when it finishes.',
          );
        const definition: IntentDefinition = {
          definitionId: input.definitionId,
          change: input.change,
          contentHash: input.contentHash,
          ...(input.assets ? { assets: true } : {}),
        };
        if (input.change === 'replaced') {
          const info = localPipelineService.getPipeline(input.definitionId);
          const text = localPipelineService.getPipelineText(input.definitionId);
          if (!info.success || !info.data || !text.success || !text.data)
            throw new Error(
              info.error ?? text.error ?? 'Failed to read the workflow',
            );
          definition.previous = {
            text: text.data,
            name: info.data.info.name,
            description: info.data.info.description,
            icon: info.data.info.icon,
          };
        }
        intent.definitions.push(definition);
        claimedDefinitions.set(input.definitionId, intent.id);
        await save();
      },
      async noteAssetFiles(definitionId, plan): Promise<void> {
        const definition = definitionFor(definitionId);
        if (definition.assetFiles)
          throw new Error(
            `Install intent already noted files of ${definitionId}`,
          );
        if (!INSTALL_STAGING.test(plan.stagingName))
          throw new Error(
            `Install intent got a staging folder name that is not an install's: ${plan.stagingName}`,
          );
        // Before the first snapshot byte, not only at the save.
        await assertWritable();
        const kept = snapshotsDir(intent.id);
        let keptDirReady = false;
        const files: IntentAssetFile[] = [];
        for (const write of plan.files) {
          const current = await readAssetFile(
            assetPath(definitionId, write.path),
          );
          let previous: PreviousAssetFile | null;
          if (current.kind === 'absent') previous = null;
          else if (current.kind === 'symlink')
            throw new Error(
              `The workflow file ${write.path} is a link, so the update cannot replace it.`,
            );
          else if (current.kind === 'file') {
            if (!keptDirReady) {
              await mkdir(kept, { recursive: true, mode: 0o700 });
              await syncDirectory(getPipelineInstallIntentsDir());
              keptDirReady = true;
            }
            const copy = path.join(kept, current.sha256);
            if ((await readAssetFile(copy)).kind === 'absent')
              await writeFileAtomically(copy, current.bytes, {
                mode: 0o600,
                durable: true,
              });
            previous = {
              kind: 'file',
              sha256: current.sha256,
              mode: current.mode,
            };
          } else
            throw new Error(
              `The workflow file ${write.path} is a folder or special file, so the update cannot replace it.`,
            );
          files.push({ path: write.path, next: write.sha256, previous });
        }
        const manifest = await readAssetFile(
          getPipelineAssetsManifestPath(definitionId),
        );
        if (manifest.kind === 'symlink' || manifest.kind === 'other')
          throw new Error(
            `The file record of workflow ${definitionId} is not a file, so the update cannot replace it.`,
          );
        definition.assetFiles = {
          files,
          staging: plan.stagingName,
          createdDirectories: [...plan.createdDirectories],
          manifest: {
            previous:
              manifest.kind === 'file' ? manifest.bytes.toString('utf8') : null,
            next: sha256Of(plan.manifestText),
          },
        };
        await save();
      },
      async noteInstallRecord(definitionId, next): Promise<void> {
        if (!installRecords)
          throw new PipelineInstallJournalLeftForHostError('install_records');
        const definition = definitionFor(definitionId);
        // A second note keeps the record from before the install's first write.
        const previous = definition.installRecord
          ? definition.installRecord.previous
          : await findCapabilityPackageInstallByOwner(
              getPipelinePackageInstallStorePath(),
              { kind: 'pipeline', localPipelineId: definitionId },
            );
        definition.installRecord = {
          previous,
          next: next === null ? null : installRecordIdentity(next),
        };
        await save();
      },
      async noteReceipt(definitionId, effect): Promise<void> {
        if (!environment.installReceipts)
          throw new PipelineInstallJournalLeftForHostError('install_receipts');
        const definition = definitionFor(definitionId);
        definition.receipt = {
          accountId: effect.accountId,
          receipt: effect.receipt,
          previous: definition.receipt
            ? definition.receipt.previous
            : (effect.previous ?? null),
        };
        await save();
      },
      async finish(markerClears = [], subscription): Promise<void> {
        if (markerClears.length === 0) return settle();
        await assertWritable();
        // Recovery switches from rollback to cleanup at this durable write.
        await writeIntent({
          ...intent,
          markerClears,
          ...(subscription && { subscription }),
        });
        intent.markerClears = markerClears;
        try {
          await finalizeCommittedIntent(
            intent.id,
            markerClears,
            subscription,
            'live',
          );
          written = false;
          release();
          ended('finished');
        } catch (error) {
          unconfirmedIntents.add(intent.id);
          ended('unconfirmed');
          logMainProcessWarn(
            '[pipeline-install] Committed install needs marker cleanup',
            error,
          );
          throw new PipelineInstallCleanupPendingError();
        }
      },
      async rollBack(): Promise<void> {
        if (intent.markerClears) return;
        // A rollback that fails leaves the record for startup recovery, so what
        // it covers stays claimed for the rest of this process, and no run
        // starts against it.
        if (written) {
          await Promise.resolve().then(assertWritable).catch(leftForOwner);
          await rollBackIntent(intent).catch((error: unknown) => {
            unconfirmedIntents.add(intent.id);
            ended('unconfirmed');
            throw error;
          });
          noteUndoneDefinitions(intent);
        }
        written = false;
        release();
        ended('undone');
      },
    };
  }

  return {
    recoverInterruptedPipelineInstalls,
    isPipelineDefinitionClaimed,
    whenPipelineInstallsRecovered,
    whenPipelineDefinitionRecovered,
    pipelineDefinitionRecoveryRefusal,
    beginPipelineInstallIntent,
  };
}
