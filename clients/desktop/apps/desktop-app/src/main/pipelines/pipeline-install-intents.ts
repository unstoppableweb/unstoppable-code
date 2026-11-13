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
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  rmdir,
  symlink,
} from 'node:fs/promises';
import * as path from 'node:path';
import { isSafeCapabilityRelativePath } from '@canopy/protocol/capability-files';
import { hashPipelinePackageYaml } from '@canopy/desktop-shared/node';
import { pruneDamagedCopies } from '@canopy/execution-engine/node/lib/damaged-copies';
import {
  isInstallReceipt,
  type InstallReceipt,
} from '@canopy/execution-engine/lib/resource-context-policy';
import {
  inspectStoredPipelineDocument,
  removeUnlistedStoredPipelineDocument,
  removeStoredPipeline,
  writeStoredPipeline,
} from '@canopy/execution-engine/pipelines/store';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import type {
  CapabilityPackageInstallRecordV1,
  PipelinePackageInstallRecordV1,
} from '@canopy/execution-engine/types/pipeline';
import { recordSharedItemLocalUninstall } from '../canopy-cloud/shared-item-subscriptions';
import {
  createDirectoryDurably,
  syncDirectory,
  writeFileAtomically,
} from '../lib/atomic-file';
import { writeStoreFileDurably } from '../lib/durable-store-write';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  getDataDir,
  getPipelineAssetsDir,
  getPipelineAssetsManifestPath,
  getPipelineInstallIntentsDir,
  getPipelinePackageInstallStorePath,
} from '../lib/paths';
import { createResourceInstallReceiptsStore } from '../lib/resource-install-receipts';
import type { PipelineAssetInstallPlan } from './pipeline-asset-install';
import { deleteUserPipelineLocalMetadata } from './pipeline-local-metadata-store';
import {
  findCapabilityPackageInstallByOwner,
  removeCapabilityPackageInstall,
  upsertCapabilityPackageInstall,
} from './pipeline-package-install-store';
import * as localPipelineService from './pipeline-service';

/** Version 2 records also note supporting files (CAN-5677). */
const INTENT_VERSION = 2;
const INTENT_FILE = /^[0-9a-f-]{36}\.json$/;
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
 * The supporting files an install changes in a pipeline that existed
 * before it: each file it writes, the folders it creates, and `assets.json`.
 */
interface IntentAssets {
  files: IntentAssetFile[];
  createdDirectories: string[];
  manifest: { previous: string | null; next: string };
}

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
  /** Supporting files changed in a definition that was already there. */
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

interface IntentFileV1 {
  /** 2 once any definition notes `assetFiles`; 1 otherwise. */
  version: 1 | 2;
  id: string;
  source: PipelineInstallIntentSource;
  startedAt: string;
  definitions: IntentDefinition[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  return {
    files,
    createdDirectories,
    manifest: { previous: value.manifest.previous, next: value.manifest.next },
  };
}

function parseDefinition(value: unknown): IntentDefinition | null {
  if (
    !isRecord(value) ||
    typeof value.definitionId !== 'string' ||
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
  | { kind: 'intent'; intent: IntentFileV1 }
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
    (value.version !== 1 && value.version !== 2) ||
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
  return {
    kind: 'intent',
    intent: {
      version: value.version,
      id: value.id,
      source: value.source,
      startedAt: value.startedAt,
      definitions,
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

async function writeIntent(intent: IntentFileV1): Promise<void> {
  // The folder's own entry must survive power loss with the record, before
  // any write the record covers (CAN-5678).
  await createDirectoryDurably(getPipelineInstallIntentsDir(), {
    dataRoot: getDataDir(),
  });
  // A build that knows only version 1 leaves a record noting files alone
  // instead of rolling it back without them.
  const version = intent.definitions.some((entry) => entry.assetFiles) ? 2 : 1;
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

function sha256Of(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A supporting file's path, under the pipeline's asset dir. */
function assetPath(definitionId: string, relativePath: string): string {
  const root = getPipelineAssetsDir(definitionId);
  return relativePath === '.'
    ? root
    : path.join(root, ...relativePath.split('/'));
}

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

/** Puts back what a supporting file held before the install wrote it. */
async function restoreAssetFile(
  intentId: string,
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
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await symlink(previous.target, temporary);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

const INSTALL_TEMPORARY = /^(.+)\.[0-9a-f-]{36}\.tmp$/;
const DURABLE_INSTALL_TEMPORARY = /^\.(.+)\.[0-9]+\.[0-9a-f-]{36}\.tmp$/;

/**
 * Removes legacy `<name>.<uuid>.tmp` and durable `.<name>.<pid>.<uuid>.tmp`
 * files written before renaming over `targets`: an exit leaves one behind.
 */
async function removeInstallTemporaries(
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

async function flushFolderIfPresent(folder: string): Promise<void> {
  try {
    await lstat(folder);
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return;
    throw error;
  }
  await syncDirectory(folder);
}

async function removeEmptyFolder(folder: string): Promise<void> {
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
 * it is empty. A later edit stays.
 */
async function undoAssetFiles(
  intentId: string,
  definition: IntentDefinition,
): Promise<void> {
  const assets = definition.assetFiles;
  if (!assets) return;
  const id = definition.definitionId;
  // A linked document is never rewritten: only while it still holds the YAML
  // the install linked are its files the install's. An edited one keeps them.
  if (
    definition.change === 'linked' &&
    storedHash(id) !== definition.contentHash
  )
    return;
  const manifestPath = getPipelineAssetsManifestPath(id);
  await removeInstallTemporaries([
    ...assets.files.map((file) => assetPath(id, file.path)),
    manifestPath,
  ]);
  for (const file of [...assets.files].reverse()) {
    const target = assetPath(id, file.path);
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
    await restoreAssetFile(intentId, target, file.previous);
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
    await removeEmptyFolder(assetPath(id, folder));
  // A removal, rename or folder removal persists only with its folder, so
  // each is flushed before the record and its kept copies can go.
  const folders = new Set<string>([path.dirname(manifestPath)]);
  for (const file of assets.files)
    folders.add(path.dirname(assetPath(id, file.path)));
  for (const folder of assets.createdDirectories)
    folders.add(path.dirname(assetPath(id, folder)));
  for (const folder of folders) await flushFolderIfPresent(folder);
}

function storedHash(definitionId: string): string | undefined {
  const state = inspectStoredPipelineDocument(definitionId);
  return state.kind === 'stored'
    ? hashPipelinePackageYaml(state.rawContent)
    : undefined;
}

type DefinitionState =
  | { kind: 'absent' }
  | { kind: 'stored'; hash: string; revision: number }
  | { kind: 'unlisted'; hash: string };

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
  await rm(getPipelineAssetsDir(id), { recursive: true, force: true });
  await rm(getPipelineAssetsManifestPath(id), { force: true });
  // Flushed before the record goes, so power loss cannot bring them back
  // with nothing left to remove them (CAN-5678).
  await flushFolderIfPresent(path.dirname(getPipelineAssetsManifestPath(id)));
}

/**
 * Undoes one definition's document. `removed` when this rollback deleted a
 * copy the install created, `undone` when it otherwise no longer holds what
 * the install wrote, `kept` when it holds content nobody can attribute to
 * the install (a later edit), which keeps its records and receipt with it.
 */
async function undoDefinition(
  definition: IntentDefinition,
): Promise<'removed' | 'undone' | 'kept'> {
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
    if (state.hash !== definition.contentHash) return 'kept';
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
    if (record !== null && record !== (definition.installRecord?.next ?? null))
      return 'kept';
    const current = inspectStoredPipelineDocument(id);
    if (
      current.kind !== 'stored' ||
      hashPipelinePackageYaml(current.rawContent) !== definition.contentHash
    )
      return 'kept';
    const removed = removeStoredPipeline(id, {
      expectedRevision: current.revision,
    });
    if (!removed.ok) {
      if (removed.reason === 'revision_conflict') return 'kept';
      throw new Error(removed.message);
    }
    deleteUserPipelineLocalMetadata(id);
    await removeCreatedAssets(definition);
    return 'removed';
  }
  const previous = definition.previous;
  if (!previous || state.kind !== 'stored') return 'kept';
  if (state.hash === hashPipelinePackageYaml(previous.text)) return 'undone';
  if (state.hash !== definition.contentHash) return 'kept';
  const current = inspectStoredPipelineDocument(id);
  if (
    current.kind !== 'stored' ||
    hashPipelinePackageYaml(current.rawContent) !== definition.contentHash
  )
    return 'kept';
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
    if (restored.reason === 'revision_conflict') return 'kept';
    throw new Error(restored.message);
  }
  return 'undone';
}

async function undoInstallRecord(definition: IntentDefinition): Promise<void> {
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

async function rollBackIntent(intent: IntentFileV1): Promise<void> {
  const failures: string[] = [];
  const undone: Array<{ definition: IntentDefinition; removed: boolean }> = [];
  for (const definition of [...intent.definitions].reverse()) {
    try {
      const outcome = await undoDefinition(definition);
      if (outcome === 'kept') continue;
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
 */
export async function recoverInterruptedPipelineInstalls(): Promise<void> {
  let names: string[];
  try {
    names = await readdir(getPipelineInstallIntentsDir());
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return;
    throw error;
  }
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
        const setAside = `.unreadable-${Date.now()}`;
        await rename(file, `${file}${setAside}`);
        await rename(snapshotsDir(id), `${snapshotsDir(id)}${setAside}`).catch(
          (error: unknown) => {
            if (!isRecord(error) || error.code !== 'ENOENT') throw error;
          },
        );
        await pruneSetAsideRecords();
        logMainProcessWarn(
          '[pipeline-install] Set aside an unreadable install record',
          { id },
        );
        continue;
      }
      try {
        await rollBackIntent(parsed.intent);
        releaseClaims(parsed.intent.id);
      } catch (error) {
        // Its record stays for the next start; until then no install of this
        // process may take over what it covers.
        claimDefinitions(parsed.intent);
        throw error;
      }
    } catch (error) {
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

function claimDefinitions(intent: IntentFileV1): void {
  for (const definition of intent.definitions)
    claimedDefinitions.set(definition.definitionId, intent.id);
}

function releaseClaims(intentId: string): void {
  for (const [definitionId, owner] of Array.from(claimedDefinitions))
    if (owner === intentId) claimedDefinitions.delete(definitionId);
}

/**
 * True while an unfinished install covers the definition. Another install
 * must not adopt or change it: that install's rollback could undo its work.
 */
export function isPipelineDefinitionClaimed(definitionId: string): boolean {
  return claimedDefinitions.has(definitionId);
}

let recovery: Promise<void> | undefined;

/**
 * Startup recovery, run once per process. Every install waits for it, so a
 * reinstall never runs beside the rollback of the attempt it repeats.
 */
export function whenPipelineInstallsRecovered(): Promise<void> {
  recovery ??= recoverInterruptedPipelineInstalls().catch((error: unknown) => {
    logMainProcessWarn(
      '[pipeline-install] Install recovery did not finish',
      error,
    );
  });
  return recovery;
}

export interface PipelineInstallIntent {
  /**
   * Before saving `definitionId`: a `created` id must be new, a `replaced`
   * definition's current document is kept for rollback, and a `linked` one
   * is left as it is while its records change.
   */
  noteDefinition(input: {
    definitionId: string;
    change: IntentDefinition['change'];
    contentHash: string;
    assets?: true;
  }): Promise<void>;
  /**
   * Before writing the supporting files of a definition that was already
   * there: keeps a copy of every file the plan overwrites, then notes each
   * file, the folders it creates and `assets.json`. A created definition's
   * files go with it, so nothing is kept for it.
   */
  noteAssetFiles(
    definitionId: string,
    plan: PipelineAssetInstallPlan,
  ): Promise<void>;
  /** Before writing (or, with `null`, removing) the definition's record. */
  noteInstallRecord(
    definitionId: string,
    next: PipelinePackageInstallRecordV1 | null,
  ): Promise<void>;
  /** Before recording `receipt` for the definition. */
  noteReceipt(
    definitionId: string,
    effect: {
      accountId: string;
      receipt: InstallReceipt;
      previous: InstallReceipt | undefined;
    },
  ): Promise<void>;
  /** The install committed: its record goes. */
  finish(): Promise<void>;
  /**
   * The install failed: undo what is left of it after the caller's own
   * rollback, then drop the record. When an undo fails the record stays for
   * startup recovery and this rejects.
   */
  rollBack(): Promise<void>;
}

/** Starts an install's record; nothing is written until its first note. */
export async function beginPipelineInstallIntent(
  source: PipelineInstallIntentSource,
): Promise<PipelineInstallIntent> {
  await whenPipelineInstallsRecovered();
  const intent: IntentFileV1 = {
    version: INTENT_VERSION,
    id: randomUUID(),
    source,
    startedAt: new Date().toISOString(),
    definitions: [],
  };
  let written = false;
  const save = async (): Promise<void> => {
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
  const settle = async (): Promise<void> => {
    if (written) await removeIntent(intent.id);
    written = false;
    release();
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
      if (definition.change === 'created') return;
      if (definition.assetFiles)
        throw new Error(
          `Install intent already noted files of ${definitionId}`,
        );
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
          previous = { kind: 'symlink', target: current.target };
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
    finish: settle,
    async rollBack(): Promise<void> {
      // A rollback that fails leaves the record for startup recovery, so what
      // it covers stays claimed for the rest of this process.
      if (written) await rollBackIntent(intent);
      written = false;
      release();
    },
  };
}
