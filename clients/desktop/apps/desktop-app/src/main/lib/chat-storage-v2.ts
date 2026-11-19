import { enumerateDelegationRegistryAnswerReferences } from './chat-delta-journal/delegation-registry-store';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, type BigIntStats } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative as relativeTo,
  sep,
} from 'node:path';
import type {
  ArchivedChatEntry,
  ChatTabsFile,
  PersistedChatTab,
  ChatRuntimeState,
  PersistedCommandReceipt,
} from '@canopy/desktop-shared/types';
import type {
  PersistedChatMessage,
  PersistedToolOutputReference,
} from '@canopy/agent-transcript/types';
import { PersistedToolOutputReferenceSchema } from '@canopy/protocol/canopy-core';
import type { VisualOwnerFence } from './chat-visual-contracts';
import {
  artifactRelativePath,
  storedArtifactDirectories,
  storedArtifactRefsOf,
} from './chat-artifact-references';
import { assertTranscriptIdentity } from './chat-transcript-artifacts';
import {
  assertNoNewerChatStorageManifest,
  ChatDeltaJournalIntegrityError,
  ChatStorageNewerFormatError,
  DELTA_CHECKPOINT_MARKER_NAME,
  DELTA_CHECKPOINT_STAGED_SUFFIX,
  DELTA_CHECKPOINT_WORK_DIRECTORY,
  DELTA_JOURNAL_FILE_NAME,
  DELTA_JOURNAL_V2_FILE_NAME,
  type DeltaJournalStorageManifest,
  type Format4CheckpointedManifest,
  type Format4StorageManifest,
  type ChatStorageV2Manifest as StorageManifest,
  isChatStorageV2Manifest as isStorageManifest,
  journalFileFor,
  parseChatStorageManifest,
  selectJournal,
} from './chat-delta-journal/format';
import {
  loadStreamCatalog,
  loadStreamRegistry,
  parseStreamDescriptor,
  streamDescriptorAnswerReferences,
  streamRegistryPaths,
  validateStreamClosure,
} from './chat-delta-journal/stream-registry';
import { delegationTranscriptPaths } from './transcript-stream-paths';
import {
  readReplayedChatIndexes,
  summarizeDeltaJournal,
} from './chat-delta-journal/reader';
import {
  ChatTranscriptLog,
  TranscriptStreamStore,
  readCompleteTranscriptMessages,
  type TranscriptDescriptor,
} from './chat-transcript-log';
import { ChatTranscriptArtifacts } from './chat-transcript-artifacts';
import { chatChildDeleteFence } from './chat-child-delete-fence';
import {
  recordChatStorageAtomicReplacement,
  recordChatStorageFileSync,
  recordChatStorageFileWrite,
  recordChatStorageIndexParses,
  recordChatStorageIndexSerializations,
} from '@canopy/desktop-shared/node/work-counters';
import { fsyncDirectory } from './fsync-directory';
import { writeJsonValuesCooperatively } from './cooperative-json';
import { classifyError } from '@canopy/protocol/app-errors/classification';
import { isErrnoException, isRecord } from './type-guards';

export interface ChatIndexEntry extends Omit<
  PersistedChatTab,
  'messages' | 'transcriptLoaded' | 'transcriptWindow'
> {
  transcript: TranscriptDescriptor;
}

export interface ChatLiveIndex extends Omit<ChatTabsFile, 'version' | 'tabs'> {
  version: 2;
  revision: number;
  tabs: ChatIndexEntry[];
  runtimeByChatId: Record<string, ChatRuntimeState>;
}

export interface ChatArchiveIndex {
  version: 2;
  revision: number;
  archived: Array<Omit<ArchivedChatEntry, 'tab'> & { tab: ChatIndexEntry }>;
}

/** Retained command/replay fences are metadata; never carry v1 message rows. */
export interface ChatRecoveryIndex {
  version: 2;
  receipts: PersistedCommandReceipt[];
  mutationIds: string[];
  removedTabIds: string[];
  removedArchiveEntryIds: string[];
  removedMessageIds: string[];
  /** JSON [chatId, messageId] tuples; scoped fences for new recovery writes. */
  removedMessageKeys?: string[];
  /** First-block ownership fences for staged visuals; absent when empty. */
  visualOwnersByChatId?: Record<string, Record<string, VisualOwnerFence>>;
  /**
   * Legacy files retained as evidence: unreadable sources, and family files
   * migration read but did not use or never reads (a superseded snapshot, the
   * journal backup), so legacy cleanup may remove the originals.
   */
  legacyEvidence?: Array<{
    relativePath: string;
    byteLength: number;
    sha256: string;
  }>;
}

function isChatLiveIndex(value: unknown): value is ChatLiveIndex {
  return (
    isRecord(value) &&
    value.version === 2 &&
    Number.isSafeInteger(value.revision) &&
    typeof value.activeTabId === 'string' &&
    Array.isArray(value.tabs) &&
    value.tabs.every(isRecord) &&
    isRecord(value.runtimeByChatId)
  );
}

function isChatArchiveIndex(value: unknown): value is ChatArchiveIndex {
  return (
    isRecord(value) &&
    value.version === 2 &&
    Number.isSafeInteger(value.revision) &&
    Array.isArray(value.archived) &&
    value.archived.every((entry) => isRecord(entry) && isRecord(entry.tab))
  );
}

function isChatRecoveryIndex(value: unknown): value is ChatRecoveryIndex {
  return (
    isRecord(value) &&
    value.version === 2 &&
    Array.isArray(value.receipts) &&
    (value.removedMessageKeys === undefined ||
      (Array.isArray(value.removedMessageKeys) &&
        value.removedMessageKeys.every((key) => typeof key === 'string'))) &&
    [
      value.mutationIds,
      value.removedTabIds,
      value.removedArchiveEntryIds,
      value.removedMessageIds,
    ].every(
      (ids) => Array.isArray(ids) && ids.every((id) => typeof id === 'string'),
    )
  );
}

/**
 * The live and archive indexes are each valid but carry different
 * revisions. A lease-free reader of a version 3 scope meets this when a
 * checkpoint publishes the two files between its reads, so it retries; every
 * other caller fails closed on it exactly as on any invalid index. The
 * message and name stay those of the plain error it replaces.
 */
export class ChatStorageIndexRevisionMismatchError extends Error {}

/** Validate the same canonical index contract for disk reads and commits. */
export function assertChatStorageIndexes(
  indexes: unknown,
  options: {
    allowPendingTranscriptDescriptors?: boolean;
    pendingTranscriptChatIds?: ReadonlySet<string>;
  } = {},
): asserts indexes is {
  live: ChatLiveIndex;
  archive: ChatArchiveIndex;
  recovery: ChatRecoveryIndex;
} {
  if (
    !isRecord(indexes) ||
    !isChatLiveIndex(indexes.live) ||
    !isChatArchiveIndex(indexes.archive)
  )
    throw new Error('Invalid v2 chat indexes');
  if (indexes.live.revision !== indexes.archive.revision)
    throw new ChatStorageIndexRevisionMismatchError('Invalid v2 chat indexes');
  if (!isChatRecoveryIndex(indexes.recovery))
    throw new Error('Invalid v2 recovery metadata');
  const ids = new Set<string>();
  for (const tab of [
    ...indexes.live.tabs,
    ...indexes.archive.archived.map((entry) => entry.tab),
  ]) {
    if (typeof tab.id !== 'string')
      throw new Error('Invalid or duplicate chat index entry');
    assertTranscriptIdentity(tab.id);
    if (
      (tab.transcript?.lastMessageRole !== undefined &&
        tab.transcript.lastMessageRole !== 'user' &&
        tab.transcript.lastMessageRole !== 'assistant') ||
      'messages' in tab ||
      ids.has(tab.id) ||
      (!options.allowPendingTranscriptDescriptors &&
        !options.pendingTranscriptChatIds?.has(tab.id) &&
        tab.transcript?.format !== 'complete-message-jsonl-v1')
    )
      throw new Error('Invalid or duplicate chat index entry');
    ids.add(tab.id);
  }
}

/** What a scope transaction needs to know about the committed indexes. */
export interface ChatIndexSummary {
  revision: number;
  /** Every indexed chat, live and archived. */
  chatIds: ReadonlySet<string>;
}

const INDEX_FILE_NAMES = [
  'live-index.json',
  'archive-index.json',
  'recovery-index.json',
] as const;

/** Identifies one file version; any replacement or rewrite changes it. */
function fileIdentity(info: BigIntStats): string {
  return [
    info.dev,
    info.ino,
    info.size,
    info.mtimeNs,
    info.ctimeNs,
    info.birthtimeNs,
  ].join(':');
}

function sameIdentities(
  current: readonly string[] | undefined,
  cached: { identities: readonly string[] },
): boolean {
  return (
    current !== undefined &&
    current.length === cached.identities.length &&
    current.every((identity, index) => identity === cached.identities[index])
  );
}

function summarizeIndexes(indexes: {
  live: ChatLiveIndex;
  archive: ChatArchiveIndex;
}): ChatIndexSummary {
  return {
    revision: indexes.live.revision,
    chatIds: new Set([
      ...indexes.live.tabs.map((tab) => tab.id),
      ...indexes.archive.archived.map((entry) => entry.tab.id),
    ]),
  };
}

export interface ChatMigrationEntry {
  metadata: Omit<PersistedChatTab, 'messages'>;
  archive?: Omit<ArchivedChatEntry, 'tab'>;
  messages: AsyncIterable<PersistedChatMessage>;
}

export interface ChatMigrationSource {
  revision: number;
  index: Omit<ChatLiveIndex, 'version' | 'tabs' | 'revision'>;
  recovery: Omit<ChatRecoveryIndex, 'version'>;
  evidence?: readonly string[];
  /**
   * Files kept as evidence when they can be copied. One that can't be copied
   * stays where it is, and legacy cleanup refuses to remove it.
   */
  optionalEvidence?: readonly string[];
  /** The legacy family files this source was built from. */
  consumedSources?: readonly string[];
  assertUnchanged?: () => Promise<void>;
  /** The caller holds a settled scope lease until migration finishes. */
  chats: AsyncIterable<ChatMigrationEntry>;
}

export type ChatMigrationCheckpoint =
  | 'staged'
  | 'validated'
  | 'promoted'
  | 'manifest'
  | 'cleaned';

export interface ChatStorageV2Descriptor {
  workspaceRoot: string;
  scopeId: string;
  legacyPaths?: readonly string[];
}

const ACTIVE_STATUSES = new Set([
  'queued',
  'starting',
  'streaming',
  'awaiting_input',
  'completing',
]);

// Instances in main share migration admission; callers also hold the scope
// lease excluding active turns and ordinary writes across source conversion.
const migrationTails = new Map<string, Promise<void>>();

/** The legacy family files a version 2 store was migrated from. */
const LEGACY_SOURCES_FILE = 'legacy-sources.json';

async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  let renamed = false;
  try {
    await writeJsonValuesCooperatively(temporary, [value], { pretty: false });
    await rename(temporary, path);
    renamed = true;
    recordChatStorageAtomicReplacement(path);
    await fsyncDirectory(dirname(path));
  } finally {
    if (!renamed) await rm(temporary, { force: true });
  }
}

function isMissing(error: unknown): boolean {
  return (
    isErrnoException(error) &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Clears a directory promotion's destination. A file there is refused: a
 * Windows rename would silently replace it with the staged tree (CAN-5151).
 * Migration admission and the scope lease exclude this process's writers,
 * so only another process could create one between the check and rename.
 */
async function clearPromotionDestination(path: string): Promise<void> {
  let stats: BigIntStats;
  try {
    stats = await lstat(path, { bigint: true });
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return;
    throw error;
  }
  if (stats.isFile())
    throw new Error('Refusing to promote chat storage over a file');
  await rm(path, { recursive: true });
}

async function hashFile(
  path: string,
): Promise<{ byteLength: number; sha256: string }> {
  const hash = createHash('sha256');
  let byteLength = 0;
  for await (const chunk of createReadStream(path)) {
    if (!Buffer.isBuffer(chunk)) throw new Error('File stream returned text');
    hash.update(chunk);
    byteLength += chunk.length;
  }
  return { byteLength, sha256: hash.digest('hex') };
}

/** Copy one evidence file, verify the copy byte for byte, and sync it. */
async function copyEvidence(
  path: string,
  target: string,
): Promise<{ byteLength: number; sha256: string }> {
  const original = await hashFile(path);
  await copyFile(path, target);
  const copied = await hashFile(target);
  if (
    original.sha256 !== copied.sha256 ||
    original.byteLength !== copied.byteLength
  )
    throw new Error('Legacy recovery evidence changed during copy');
  const handle = await open(target, 'r+');
  try {
    await handle.sync();
    recordChatStorageFileWrite(target, original.byteLength, false);
    recordChatStorageFileSync(target);
  } finally {
    await handle.close();
  }
  return original;
}

async function* treeFiles(root: string, relative = ''): AsyncGenerator<string> {
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = join(relative, entry.name);
    if (entry.isDirectory()) yield* treeFiles(root, path);
    else if (entry.isFile()) yield path;
    else
      throw new Error('Chat storage contains an unsupported filesystem entry');
  }
}

async function treeDigest(
  root: string,
  include: (relativePath: string) => boolean = () => true,
): Promise<string> {
  const hash = createHash('sha256');
  for await (const path of treeFiles(root)) {
    if (!include(path)) continue;
    hash
      .update(JSON.stringify([path, await hashFile(join(root, path))]))
      .update('\n');
  }
  return hash.digest('hex');
}

async function copyTreeVerified(
  source: string,
  destination: string,
  include: (relativePath: string) => boolean = () => true,
): Promise<string> {
  await mkdir(destination, { recursive: true });
  const hash = createHash('sha256');
  const directories = new Set([destination]);
  for await (const path of treeFiles(source)) {
    if (!include(path)) continue;
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true });
    let parent = dirname(target);
    while (parent !== dirname(destination)) {
      directories.add(parent);
      if (parent === destination) break;
      parent = dirname(parent);
    }
    const original = await hashFile(join(source, path));
    await copyFile(join(source, path), target);
    const copied = await hashFile(target);
    if (
      copied.sha256 !== original.sha256 ||
      copied.byteLength !== original.byteLength
    )
      throw new Error('Chat storage copy failed integrity validation');
    // Windows requires write access for fsync; r+ preserves the copied bytes.
    const handle = await open(target, 'r+');
    try {
      await handle.sync();
      recordChatStorageFileWrite(target, original.byteLength, false);
      recordChatStorageFileSync(target);
    } finally {
      await handle.close();
    }
    hash.update(JSON.stringify([path, original])).update('\n');
  }
  for (const directory of Array.from(directories).sort(
    (a, b) => b.length - a.length,
  ))
    await fsyncDirectory(directory);
  return hash.digest('hex');
}

/**
 * Visit every committed and open row of each registered child stream of a
 * format 4 tree, verifying every body reference against its parent chat,
 * which owns child artifacts.
 */
async function verifyChildStreamRows(
  root: string,
  artifacts: ChatTranscriptArtifacts,
  visit: (
    reference: PersistedToolOutputReference,
    parentChatId: string,
  ) => void | Promise<void>,
  owningChats: ReadonlySet<string>,
): Promise<void> {
  const catalog = await loadStreamCatalog(root);
  for (const parentChatId of Array.from(owningChats)) {
    const registry = catalog.parents[parentChatId]
      ? await loadStreamRegistry(root, parentChatId, { readOnly: true })
      : undefined;
    for await (const reference of enumerateDelegationRegistryAnswerReferences(
      root,
      parentChatId,
    )) {
      await artifacts.verify(parentChatId, reference);
      await visit(reference, parentChatId);
    }
    for (const entry of registry?.entries ?? []) {
      const paths = streamRegistryPaths(root, parentChatId, entry.streamKey);
      const descriptor = parseStreamDescriptor(
        await readFile(paths.descriptor),
      );
      for (const candidate of streamDescriptorAnswerReferences(descriptor)) {
        const reference = PersistedToolOutputReferenceSchema.parse(candidate);
        await artifacts.verify(parentChatId, reference);
        await visit(reference, parentChatId);
      }
      const child = new TranscriptStreamStore(
        delegationTranscriptPaths(root, entry.target),
        artifacts,
        undefined,
        { readOnly: true, childMode: true },
      );
      const verifyRow = async (row: PersistedChatMessage): Promise<void> => {
        for await (const reference of artifacts.referenceClosure(
          parentChatId,
          row,
        )) {
          await artifacts.verify(parentChatId, reference);
          await visit(reference, parentChatId);
        }
      };
      for await (const row of readCompleteTranscriptMessages(paths.log))
        await verifyRow(row);
      for (const row of await child.activeMessages(entry.streamKey))
        await verifyRow(row);
    }
  }
}

async function reachableToolOutputPaths(
  directory: string,
  indexes: { live: ChatLiveIndex; archive: ChatArchiveIndex },
  format: 'v1' | 'v2' | 'v3' | 'v4',
): Promise<Set<string>> {
  const root = join(directory, 'transcripts');
  const transcript = new ChatTranscriptLog(root, undefined, { readOnly: true });
  const paths = new Set<string>();
  const artifacts = new ChatTranscriptArtifacts(root, true);
  const addReference = (
    reference: PersistedToolOutputReference,
    chatId: string,
  ): void => {
    paths.add(
      artifactRelativePath(chatId, { family: 'tool-output', reference }),
    );
  };
  const add = async (
    message: PersistedChatMessage,
    chatId: string,
  ): Promise<void> => {
    for await (const reference of artifacts.referenceClosure(chatId, message))
      addReference(reference, chatId);
    // The closure covers tool output; visuals live on the logical blocks.
    for (const block of (await artifacts.expandBlocks(chatId, message)).blocks)
      for (const ref of storedArtifactRefsOf(block))
        paths.add(artifactRelativePath(chatId, ref));
  };
  for (const tab of [
    ...indexes.live.tabs,
    ...indexes.archive.archived.map((entry) => entry.tab),
  ]) {
    for await (const message of transcript.iterate(tab.id))
      await add(message, tab.id);
    for (const message of await transcript.activeMessages(tab.id))
      await add(message, tab.id);
  }
  if (format === 'v4')
    await verifyChildStreamRows(
      root,
      artifacts,
      addReference,
      indexedChatIds(indexes),
    );
  return paths;
}

/**
 * Delta-journal files a copy never carries: the journal of a checkpointed
 * scope holds no records, and checkpoint leftovers are never authoritative.
 * Quarantined journal tails are evidence and are carried.
 */
function isDeltaJournalWorkingFile(relativePath: string): boolean {
  return (
    relativePath === DELTA_JOURNAL_FILE_NAME ||
    relativePath === DELTA_CHECKPOINT_MARKER_NAME ||
    relativePath.startsWith(`${DELTA_CHECKPOINT_WORK_DIRECTORY}${sep}`) ||
    INDEX_FILE_NAMES.some(
      (name) => relativePath === `${name}${DELTA_CHECKPOINT_STAGED_SUFFIX}`,
    )
  );
}

/** Chats whose delegate logs a copy carries: every chat an index lists. */
function indexedChatIds(indexes: {
  live: ChatLiveIndex;
  archive: ChatArchiveIndex;
}): Set<string> {
  return new Set([
    ...indexes.live.tabs.map((tab) => tab.id),
    ...indexes.archive.archived.map((entry) => entry.tab.id),
  ]);
}

function capturePathPredicate(
  reachableArtifacts: ReadonlySet<string>,
  indexedChats: ReadonlySet<string>,
): (relativePath: string) => boolean {
  const storedArtifactRoots = storedArtifactDirectories().map(
    (directory) => `${join('transcripts', directory)}${sep}`,
  );
  const delegationRoot = join('transcripts', 'delegations');
  const pendingTranscriptRoot = 'pending-transcripts';
  const visualStagingRoot = 'visual-staging';
  return (relativePath) =>
    !relativePath.endsWith('.tmp') &&
    !isDeltaJournalWorkingFile(relativePath) &&
    relativePath !== DELTA_JOURNAL_V2_FILE_NAME &&
    !relativePath
      .split(sep)
      .some((part) => part.endsWith('.checkpoint') || part.includes('.tmp')) &&
    !relativePath.startsWith(`${pendingTranscriptRoot}${sep}`) &&
    !relativePath.startsWith(`${visualStagingRoot}${sep}`) &&
    !storedArtifactRoots.some(
      (root) =>
        relativePath.startsWith(root) && !reachableArtifacts.has(relativePath),
    ) &&
    (relativePath === join(delegationRoot, 'stream-catalog.json') ||
      !relativePath.startsWith(`${delegationRoot}${sep}`) ||
      indexedChats.has(
        relativePath.slice(delegationRoot.length + 1).split(sep)[0] ?? '',
      ));
}

/** Authority selection is manifest-only. V1 presence never overrides v2. */
export class ChatStorageV2 {
  public readonly directory: string;
  public readonly manifestPath: string;
  private readonly legacyPaths: readonly string[];
  public readonly maxManifestVersion: 3 | 4;
  private committedSummary?: {
    identities: readonly string[];
    summary: ChatIndexSummary;
  };

  public constructor(
    private readonly workspaceRoot: string,
    private readonly scopeId: string,
    legacyPaths?: readonly string[],
    options: { maxManifestVersion?: 3 | 4 } = {},
  ) {
    this.maxManifestVersion = options.maxManifestVersion ?? 4;
    assertTranscriptIdentity(scopeId);
    this.directory = join(workspaceRoot, 'chat-storage-v2', scopeId);
    this.manifestPath = join(
      workspaceRoot,
      'chat-storage-manifests',
      `${scopeId}.json`,
    );
    this.legacyPaths = legacyPaths ?? [
      join(workspaceRoot, 'chats', `${scopeId}.json`),
      join(workspaceRoot, 'chat-archives', `${scopeId}.json`),
      join(workspaceRoot, 'chat-journals', `${scopeId}.jsonl`),
    ];
  }

  public descriptor(): ChatStorageV2Descriptor {
    return {
      workspaceRoot: this.workspaceRoot,
      scopeId: this.scopeId,
      legacyPaths: this.legacyPaths,
    };
  }

  /** Reuse the canonical legacy resolver, including cowork aliases and
   * sentinel namespaces. Cleanup uses those exact resolved file families.
   */
  public static fromLegacyPaths(
    paths: {
      tabs: string;
      archives: string;
      journal: string;
    },
    options: { maxManifestVersion?: 3 | 4 } = {},
  ): ChatStorageV2 {
    const parent = dirname(paths.tabs);
    const namespace = basename(parent);
    const id = basename(paths.tabs, '.json');
    return new ChatStorageV2(
      namespace === 'chats' || namespace === 'plan-explore-chats'
        ? dirname(parent)
        : parent,
      namespace === 'plan-explore-chats' ? `${namespace}-${id}` : id,
      [paths.tabs, paths.archives, paths.journal],
      options,
    );
  }

  /**
   * The authority manifest. Version 3 selects the delta-journal format: this
   * class reads it through checkpoint + journal replay, and only the delta
   * journal writer, driven by the chat state backend, changes it.
   */
  private async manifest(): Promise<
    | StorageManifest
    | DeltaJournalStorageManifest
    | Format4StorageManifest
    | undefined
  > {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.manifestPath, 'utf8'));
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return undefined;
      throw error;
    }
    assertNoNewerChatStorageManifest(
      parsed,
      this.scopeId,
      this.maxManifestVersion,
    );
    if (isStorageManifest(parsed)) {
      if (parsed.scopeId !== this.scopeId)
        throw new Error('Invalid chat storage authority manifest');
      return parsed;
    }
    if (!isRecord(parsed) || (parsed.version !== 3 && parsed.version !== 4))
      throw new Error('Invalid chat storage authority manifest');
    const manifest = parseChatStorageManifest(parsed);
    if (manifest.scopeId !== this.scopeId)
      throw new Error('Invalid chat storage authority manifest');
    return manifest;
  }

  /** A delta-journal (version 3) scope is migrated: authority is never v1. */
  public async authority(): Promise<'v1' | 'v2'> {
    return (await this.manifest()) ? 'v2' : 'v1';
  }

  /** The manifest-selected on-disk format. */
  public async format(): Promise<'v1' | 'v2' | 'v3' | 'v4'> {
    const manifest = await this.manifest();
    if (!manifest) return 'v1';
    return manifest.version === 4 ? 'v4' : manifest.version === 3 ? 'v3' : 'v2';
  }

  /** The selected journal's file name; undefined when checkpointed. */
  public async journalFile(): Promise<string | undefined> {
    return journalFileFor(await this.manifest());
  }

  /** Every path that writes version 2 files refuses a version 3 scope. */
  private static newerFormat(): ChatStorageNewerFormatError {
    return new ChatStorageNewerFormatError(
      'Chat storage was written by a newer version of the app; this version can read it but not change it',
    );
  }

  private async prepareStorageRoots(): Promise<void> {
    await mkdir(dirname(this.directory), { recursive: true });
    await mkdir(dirname(this.manifestPath), { recursive: true });
    // Sync their containing directory, not only files inside the namespaces.
    // Repeat on retry: existence does not prove a prior mkdir was durable.
    await fsyncDirectory(dirname(dirname(this.directory)));
  }

  /**
   * The committed indexes. A version 3 scope is read through its last
   * checkpoint plus the journal records after it, never from the
   * checkpoint files alone.
   */
  public async indexes(): Promise<{
    live: ChatLiveIndex;
    archive: ChatArchiveIndex;
    recovery: ChatRecoveryIndex;
  }> {
    const manifest = await this.manifest();
    if (!manifest) throw new Error('Scope has not migrated to v2');
    if (selectJournal(manifest)) {
      // A reader without the scope lease can meet a checkpoint between its
      // reads of the marker, the indexes and the journal: an integrity
      // failure, or live and archive indexes from adjacent checkpoints. Each
      // file is replaced atomically, so a retry sees a consistent set; a
      // persistent failure still rejects.
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await readReplayedChatIndexes(
            { directory: this.directory, scopeId: this.scopeId },
            assertChatStorageIndexes,
            { maxManifestVersion: this.maxManifestVersion },
          );
        } catch (error) {
          if (
            !(
              error instanceof ChatDeltaJournalIntegrityError ||
              error instanceof ChatStorageIndexRevisionMismatchError
            ) ||
            attempt >= 3
          )
            throw error;
        }
      }
    }
    if (manifest.version === 4) {
      const root = join(this.directory, 'transcripts');
      await validateStreamClosure(root, await loadStreamCatalog(root), {
        readOnly: true,
      });
    }
    return (await this.readCommittedIndexes()).indexes;
  }

  /**
   * Whether a version 3 scope's journal holds no record after its last
   * checkpoint, so the version 2 files alone are its complete state.
   */
  private async deltaJournalCheckpointed(): Promise<boolean> {
    if (await exists(join(this.directory, DELTA_CHECKPOINT_MARKER_NAME)))
      return false;
    const summary = await summarizeDeltaJournal({
      directory: this.directory,
      scopeId: this.scopeId,
      maxManifestVersion: this.maxManifestVersion,
    });
    return summary.recordCount === 0 && !summary.tornTail;
  }

  /**
   * The committed revision and chat ids a scope transaction checks its
   * expected revision and transcript effects against. The caller holds the
   * scope's transaction order.
   *
   * The summary stays in memory while the three index files are exactly the
   * ones this store last read or published: same device, inode, size and
   * change times. Every other writer — another store instance for the same
   * scope, a migration or restore that promotes a new directory, a deleted
   * scope, an external edit — replaces or rewrites a file and changes its
   * identity, so the files are read and validated again. Only the summary is
   * kept, never an index object a caller could mutate.
   */
  public async committedIndexSummary(): Promise<ChatIndexSummary> {
    const manifest = await this.manifest();
    if (!manifest) throw new Error('Scope has not migrated to v2');
    if (selectJournal(manifest)) throw ChatStorageV2.newerFormat();
    const cached = this.committedSummary;
    if (cached && sameIdentities(await this.indexFileIdentities(), cached))
      return cached.summary;
    return (await this.readCommittedIndexes()).summary;
  }

  /**
   * Record indexes a scope transaction has just published and made durable,
   * so its next commit need not read them back.
   */
  public async recordPublishedIndexes(indexes: {
    live: ChatLiveIndex;
    archive: ChatArchiveIndex;
  }): Promise<void> {
    const identities = await this.indexFileIdentities();
    this.committedSummary = identities
      ? { identities, summary: summarizeIndexes(indexes) }
      : undefined;
  }

  private async indexFileIdentities(): Promise<readonly string[] | undefined> {
    try {
      return await Promise.all(
        INDEX_FILE_NAMES.map(async (name) =>
          fileIdentity(
            await stat(join(this.directory, name), { bigint: true }),
          ),
        ),
      );
    } catch {
      // Unknown identity: the caller reads the files and surfaces any error.
      return undefined;
    }
  }

  private async readCommittedIndexes(): Promise<{
    indexes: {
      live: ChatLiveIndex;
      archive: ChatArchiveIndex;
      recovery: ChatRecoveryIndex;
    };
    summary: ChatIndexSummary;
  }> {
    const { indexes, identities } = await this.readIndexFiles(this.directory);
    const summary = summarizeIndexes(indexes);
    const known = identities.filter(
      (identity): identity is string => identity !== undefined,
    );
    this.committedSummary =
      known.length === identities.length
        ? { identities: known, summary }
        : undefined;
    return { indexes, summary };
  }

  private async readIndexes(directory: string): Promise<{
    live: ChatLiveIndex;
    archive: ChatArchiveIndex;
    recovery: ChatRecoveryIndex;
  }> {
    return (await this.readIndexFiles(directory)).indexes;
  }

  private async readIndexFiles(directory: string): Promise<{
    indexes: {
      live: ChatLiveIndex;
      archive: ChatArchiveIndex;
      recovery: ChatRecoveryIndex;
    };
    identities: ReadonlyArray<string | undefined>;
  }> {
    const identities: Array<string | undefined> = [];
    const parsed: unknown[] = [];
    for (const name of INDEX_FILE_NAMES) {
      const path = join(directory, name);
      // Identify the file before reading it. If a writer replaces it in
      // between, the recorded identity is the older one, so the next check
      // misses and reads again; it can never vouch for content it did not
      // read. A failed stat records nothing and leaves the error to the read.
      let identity: string | undefined;
      try {
        identity = fileIdentity(await stat(path, { bigint: true }));
      } catch {
        identity = undefined;
      }
      identities.push(identity);
      parsed.push(JSON.parse(await readFile(path, 'utf8')));
    }
    const [live, archive, recovery] = parsed;
    recordChatStorageIndexParses(3);
    const indexes = { live, archive, recovery };
    assertChatStorageIndexes(indexes);
    return { indexes, identities };
  }

  /**
   * Source factory is never called once a durable v2 manifest exists.
   * Migration admits a scope for version 2 writes, so a version 3
   * (delta-journal) scope fails closed here: only its journal writer may
   * change it.
   */
  public async migrate(
    sourceFactory: () => Promise<ChatMigrationSource>,
    checkpoint: (point: ChatMigrationCheckpoint) => Promise<void> = () =>
      Promise.resolve(),
    options: { retainLegacy?: boolean } = {},
  ): Promise<void> {
    const retainLegacy = options.retainLegacy ?? false;
    const tail = (migrationTails.get(this.directory) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.migrateLocked(sourceFactory, checkpoint, retainLegacy));
    migrationTails.set(this.directory, tail);
    try {
      await tail;
    } finally {
      if (migrationTails.get(this.directory) === tail)
        migrationTails.delete(this.directory);
    }
  }

  /**
   * `retainLegacy` keeps the legacy files after version 2 validates, for a
   * scope that will promote to format 4; `completeLegacyCleanup` removes them
   * once that copy reads back. Without it they go as soon as version 2
   * validates, as before.
   */
  private async migrateLocked(
    sourceFactory: () => Promise<ChatMigrationSource>,
    checkpoint: (point: ChatMigrationCheckpoint) => Promise<void>,
    retainLegacy: boolean,
  ): Promise<void> {
    const prior = await this.manifest();
    if (prior) {
      if (selectJournal(prior)) throw ChatStorageV2.newerFormat();
      // Validation is a one-time migration operation. Afterwards each chat
      // owns its validation, and writes may legitimately advance beyond this
      // digest. `cleanupComplete` records that validation; a retained legacy
      // copy stays until the scope's format 4 copy reads back.
      if (prior.cleanupComplete) return;
      await this.prepareStorageRoots();
      await this.validate(this.directory, prior.sourceDigest);
      if (retainLegacy) await this.markValidated(prior);
      else await this.cleanup(prior);
      return;
    }
    const source = await sourceFactory();
    if (
      Object.values(source.index.runtimeByChatId).some(
        (runtime) =>
          ACTIVE_STATUSES.has(runtime.status) ||
          runtime.queuedMessageIds.length > 0,
      )
    ) {
      throw new Error('Chat migration requires all active turns to settle');
    }
    await this.prepareStorageRoots();
    const migrationId = randomUUID();
    const staging = `${this.directory}.staging-${migrationId}`;
    await mkdir(join(staging, 'transcripts'), { recursive: true });
    const transcript = new ChatTranscriptLog(join(staging, 'transcripts'));
    const live: ChatLiveIndex = {
      ...source.index,
      version: 2,
      revision: source.revision,
      tabs: [],
    };
    const archive: ChatArchiveIndex = {
      version: 2,
      revision: source.revision,
      archived: [],
    };
    const recovery: ChatRecoveryIndex = { ...source.recovery, version: 2 };
    const chatDigests = new Map<string, string>();
    const ids = new Set<string>();
    try {
      const evidence = [
        ...(source.evidence ?? []).map((path) => ({ path, required: true })),
        ...(source.optionalEvidence ?? [])
          .filter((path) => !source.evidence?.includes(path))
          .map((path) => ({ path, required: false })),
      ];
      if (evidence.length) {
        const directory = join(staging, 'recovery-evidence');
        await mkdir(directory, { recursive: true });
        recovery.legacyEvidence = [];
        for (const { path, required } of evidence) {
          const relativePath = `recovery-evidence/${recovery.legacyEvidence.length}.bin`;
          try {
            recovery.legacyEvidence.push({
              relativePath,
              ...(await copyEvidence(path, join(staging, relativePath))),
            });
          } catch (error) {
            if (required) throw error;
            await rm(join(staging, relativePath), { force: true });
          }
        }
        await fsyncDirectory(directory);
      }
      if (source.consumedSources)
        await writeJson(join(staging, LEGACY_SOURCES_FILE), {
          version: 1,
          consumed: await Promise.all(
            source.consumedSources.map(async (path) => ({
              path: relativeTo(this.workspaceRoot, path),
              ...(await hashFile(path)),
            })),
          ),
        });
      for await (const chat of source.chats) {
        const id = chat.metadata.id;
        assertTranscriptIdentity(id);
        if (ids.has(id) || 'messages' in chat.metadata)
          throw new Error('Duplicate or transcript-bearing migration metadata');
        ids.add(id);
        await transcript.initialize(id);
        const chatDigest = createHash('sha256');
        // This directory is not authoritative yet. Stream one complete staged
        // log and sync it once; per-row live append transactions would perform
        // thousands of unnecessary fsyncs while converting a large history.
        await transcript.replace(
          id,
          (async function* (): AsyncGenerator<PersistedChatMessage> {
            for await (const message of chat.messages) {
              yield message;
            }
          })(),
          source.revision,
        );
        // Digest the bounded stored representation. Externalized outputs are
        // represented by their verified content-addressed reference, so
        // validation never needs to reconstruct an arbitrarily large string.
        for await (const message of transcript.iterate(id))
          chatDigest.update(JSON.stringify(message)).update('\n');
        const entry = {
          ...chat.metadata,
          transcript: await transcript.descriptor(id),
        };
        if (chat.archive)
          archive.archived.push({ ...chat.archive, tab: entry });
        else live.tabs.push(entry);
        chatDigests.set(id, chatDigest.digest('hex'));
      }
      // Include all source metadata in the reconstruction proof, independent of
      // per-chat descriptors generated by migration.
      const digest = createHash('sha256');
      digest.update(JSON.stringify(this.metadata({ live, archive, recovery })));
      for (const id of Array.from(chatDigests.keys()).sort()) {
        digest
          .update(id)
          .update('\0')
          .update(chatDigests.get(id) ?? '')
          .update('\n');
      }
      const sourceDigest = digest.digest('hex');
      await writeJson(join(staging, 'live-index.json'), live);
      await writeJson(join(staging, 'archive-index.json'), archive);
      await writeJson(join(staging, 'recovery-index.json'), recovery);
      recordChatStorageIndexSerializations(3);
      await writeJsonValuesCooperatively(
        join(staging, 'metadata-journal.jsonl'),
        [],
        { pretty: false },
      );
      await fsyncDirectory(join(staging, 'transcripts'));
      await fsyncDirectory(staging);
      await checkpoint('staged');
      await this.validate(staging, sourceDigest);
      await checkpoint('validated');
      await source.assertUnchanged?.();
      // A prior pre-manifest promotion is unselected and can be rebuilt from
      // the locked source. Never remove a directory selected by a manifest.
      await clearPromotionDestination(this.directory);
      await rename(staging, this.directory);
      // The promoted directory holds new index files; never trust a summary
      // of the directory it replaced.
      this.committedSummary = undefined;
      recordChatStorageAtomicReplacement(this.directory);
      await fsyncDirectory(dirname(this.directory));
      await checkpoint('promoted');
      await source.assertUnchanged?.();
      const manifest: StorageManifest = {
        version: 2,
        scopeId: this.scopeId,
        migrationId,
        sourceRevision: source.revision,
        sourceDigest,
        cleanupComplete: false,
      };
      await writeJson(this.manifestPath, manifest);
      await checkpoint('manifest');
      await this.validate(this.directory, sourceDigest);
      if (retainLegacy) await this.markValidated(manifest);
      else await this.cleanup(manifest);
      await checkpoint('cleaned');
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  /** Caller holds the source scope lease. Copy complete files, validate their
   * closure, and publish destination authority last. Never aggregate transcripts
   * or hydrate large tool outputs during archive/restore.
   */
  public async copyTo(
    destination: ChatStorageV2,
    updateMetadata?: (indexes: {
      live: ChatLiveIndex;
      archive: ChatArchiveIndex;
      recovery: ChatRecoveryIndex;
    }) => void,
  ): Promise<void> {
    const prior =
      migrationTails.get(destination.directory) ?? Promise.resolve();
    const next = prior
      .catch(() => undefined)
      .then(async () => {
        // A capture copies checkpoint files. A version 3 source is copied
        // only once checkpointed (the repository flushes it under the scope
        // lease first), without its journal; a journaled destination would
        // lose its journal. Format-4 sources retain checkpointed format 4.
        if (await destination.journalFile()) throw ChatStorageV2.newerFormat();
        if (
          (await this.journalFile()) &&
          !(await this.deltaJournalCheckpointed())
        )
          throw new Error('Chat capture requires a checkpointed delta journal');
        if ((await this.authority()) !== 'v2')
          throw new Error('Chat capture source must be migrated');
        const indexes = await this.readIndexes(this.directory);
        const sourceFormat = await this.format();
        const captureLeases: Array<{
          chatId: string;
          generation: number;
          release: () => void;
        }> = [];
        const childFence = chatChildDeleteFence(
          join(this.directory, 'transcripts'),
        );
        try {
          if (sourceFormat === 'v4') {
            const root = join(this.directory, 'transcripts');
            const catalog = await loadStreamCatalog(root);
            for (const chatId of Array.from(indexedChatIds(indexes))) {
              const lease = childFence.acquire(chatId);
              if (!lease)
                throw new Error(
                  'Child stream parent was deleted during capture',
                );
              captureLeases.push({ chatId, ...lease });
            }
            await validateStreamClosure(root, catalog, {
              readOnly: true,
              deep: true,
            });
          }
          const reachableArtifacts = await reachableToolOutputPaths(
            this.directory,
            indexes,
            sourceFormat,
          );
          const includeCapturePath = capturePathPredicate(
            reachableArtifacts,
            indexedChatIds(indexes),
          );
          if (sourceFormat === 'v4') {
            if (destination.maxManifestVersion !== 4)
              throw ChatStorageV2.newerFormat();
            const root = join(this.directory, 'transcripts');
            await validateStreamClosure(root, await loadStreamCatalog(root), {
              readOnly: true,
              deep: true,
            });
            if (updateMetadata) {
              const originalIds = indexedChatIds(indexes);
              updateMetadata(indexes);
              const updatedIds = indexedChatIds(indexes);
              if (
                originalIds.size !== updatedIds.size ||
                Array.from(originalIds).some((id) => !updatedIds.has(id))
              )
                throw new Error(
                  'Format-4 capture cannot re-key transcript streams',
                );
            }
          }
          await destination.prepareStorageRoots();
          if ((await destination.authority()) === 'v2') {
            if (
              !updateMetadata &&
              (await treeDigest(this.directory, includeCapturePath)) ===
                (await treeDigest(destination.directory))
            ) {
              await destination.validateClosure(
                destination.directory,
                sourceFormat === 'v4',
              );
              if (sourceFormat === 'v4') {
                const root = join(destination.directory, 'transcripts');
                await validateStreamClosure(
                  root,
                  await loadStreamCatalog(root),
                  {
                    readOnly: true,
                    deep: true,
                  },
                );
              }
              return;
            }
            throw new Error(
              'Chat capture destination already exists with different contents',
            );
          }
          if (
            Object.values(indexes.live.runtimeByChatId).some(
              (runtime) =>
                ACTIVE_STATUSES.has(runtime.status) ||
                runtime.queuedMessageIds.length,
            )
          ) {
            throw new Error('Chat capture requires all active turns to settle');
          }
          if (
            (
              await readFile(
                join(this.directory, 'metadata-journal.jsonl'),
                'utf8',
              )
            ).trim()
          )
            throw new Error('Chat capture requires a flushed journal');
          // Source child rows were verified while collecting reachable paths.
          await this.validateClosure(
            this.directory,
            false,
            sourceFormat === 'v4',
          );
          const migrationId = randomUUID();
          const staging = `${destination.directory}.staging-${migrationId}`;
          try {
            const sourceTreeDigest = await treeDigest(this.directory);
            const sourceDigest = await copyTreeVerified(
              this.directory,
              staging,
              includeCapturePath,
            );
            // A caller-held lease excludes writes; this second digest also detects
            // unexpected external modifications before authority publication.
            if (sourceTreeDigest !== (await treeDigest(this.directory)))
              throw new Error('Chat capture source changed during copy');
            if (updateMetadata) {
              if (sourceFormat !== 'v4') updateMetadata(indexes);
              await writeJson(join(staging, 'live-index.json'), indexes.live);
              await writeJson(
                join(staging, 'archive-index.json'),
                indexes.archive,
              );
              await writeJson(
                join(staging, 'recovery-index.json'),
                indexes.recovery,
              );
              recordChatStorageIndexSerializations(3);
            }
            await destination.validateClosure(staging, sourceFormat === 'v4');
            if (sourceFormat === 'v4') {
              const catalog = await loadStreamCatalog(
                join(staging, 'transcripts'),
              );
              await validateStreamClosure(
                join(staging, 'transcripts'),
                catalog,
                {
                  readOnly: true,
                  deep: true,
                },
              );
            }
            await fsyncDirectory(staging);
            for (const lease of captureLeases)
              if (childFence.isDeleted(lease.chatId, lease.generation))
                throw new Error(
                  'Child stream parent was deleted during capture',
                );
            await clearPromotionDestination(destination.directory);
            await rename(staging, destination.directory);
            destination.committedSummary = undefined;
            recordChatStorageAtomicReplacement(destination.directory);
            await fsyncDirectory(dirname(destination.directory));
            for (const lease of captureLeases)
              if (childFence.isDeleted(lease.chatId, lease.generation))
                throw new Error(
                  'Child stream parent was deleted during capture',
                );
            const copied: Omit<Format4CheckpointedManifest, 'version'> = {
              scopeId: destination.scopeId,
              migrationId,
              sourceRevision: indexes.live.revision,
              sourceDigest,
              cleanupComplete: true,
            };
            await writeJson(
              destination.manifestPath,
              sourceFormat === 'v4'
                ? ({ version: 4, ...copied } satisfies Format4StorageManifest)
                : ({ version: 2, ...copied } satisfies StorageManifest),
            );
          } finally {
            await rm(staging, { recursive: true, force: true });
          }
        } finally {
          for (const lease of captureLeases) lease.release();
        }
      });
    migrationTails.set(destination.directory, next);
    try {
      await next;
    } finally {
      if (migrationTails.get(destination.directory) === next)
        migrationTails.delete(destination.directory);
    }
  }

  public async copyRecoveryEvidenceTo(
    destination: ChatStorageV2,
    retained: NonNullable<ChatRecoveryIndex['legacyEvidence']>,
  ): Promise<NonNullable<ChatRecoveryIndex['legacyEvidence']>> {
    if (await destination.journalFile()) throw ChatStorageV2.newerFormat();
    const combined = [...retained];
    for (const evidence of (await this.indexes()).recovery.legacyEvidence ??
      []) {
      if (!/^recovery-evidence\/\d+\.bin$/.test(evidence.relativePath))
        throw new Error('Invalid legacy evidence path');
      const actual = await hashFile(
        join(this.directory, evidence.relativePath),
      );
      if (
        actual.sha256 !== evidence.sha256 ||
        actual.byteLength !== evidence.byteLength
      )
        throw new Error('Legacy recovery evidence failed integrity validation');
      const relativePath = `recovery-evidence/${combined.length}.bin`;
      const target = join(destination.directory, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(this.directory, evidence.relativePath), target);
      const copied = await hashFile(target);
      if (
        actual.sha256 !== copied.sha256 ||
        actual.byteLength !== copied.byteLength
      )
        throw new Error('Legacy recovery evidence failed integrity validation');
      const handle = await open(target, 'r+');
      try {
        await handle.sync();
        recordChatStorageFileWrite(target, actual.byteLength, false);
        recordChatStorageFileSync(target);
      } finally {
        await handle.close();
      }
      await fsyncDirectory(dirname(target));
      combined.push({ relativePath, ...actual });
    }
    await fsyncDirectory(destination.directory);
    return combined;
  }

  /** `childStreams`: a format 4 tree, whose child rows are verified too. */
  private async validateClosure(
    directory: string,
    childStreams = false,
    allowBlockPages = childStreams,
  ): Promise<void> {
    const indexes = await this.readIndexes(directory);
    const transcript = new ChatTranscriptLog(
      join(directory, 'transcripts'),
      undefined,
      { readOnly: true },
    );
    for (const tab of [
      ...indexes.live.tabs,
      ...indexes.archive.archived.map((entry) => entry.tab),
    ]) {
      let count = 0;
      const verifyMessage = async (
        message: PersistedChatMessage,
      ): Promise<void> => {
        for await (const reference of transcript.artifacts.referenceClosure(
          tab.id,
          message,
        ))
          await transcript.artifacts.verify(tab.id, reference);
        if (!allowBlockPages && message.blocksRef)
          throw new Error('Block pages require format 4');
        const logical = await transcript.artifacts.expandBlocks(
          tab.id,
          message,
        );
        for (const block of logical.blocks) {
          for (const ref of storedArtifactRefsOf(block))
            if (ref.family === 'visual')
              await transcript.artifacts.verifyArtifact(tab.id, ref);
          if (
            block.type === 'tool_result' &&
            block.outputTruncated &&
            !block.fullOutputRef
          )
            throw new Error(
              'Truncated transcript output has no lossless reference',
            );
        }
      };
      for await (const message of transcript.iterate(tab.id)) {
        await verifyMessage(message);
        count++;
      }
      const active = await transcript.activeMessages(tab.id);
      for (const message of active) await verifyMessage(message);
      const descriptor = await transcript.descriptor(tab.id);
      if (
        count !== tab.transcript.committedMessageCount ||
        descriptor.committedByteLength !== tab.transcript.committedByteLength ||
        descriptor.messageCount !==
          (tab.transcript.messageCount ?? count + active.length)
      )
        throw new Error('Captured transcript does not match its index');
    }
    for (const evidence of indexes.recovery.legacyEvidence ?? []) {
      if (!/^recovery-evidence\/\d+\.bin$/.test(evidence.relativePath))
        throw new Error('Invalid legacy evidence path');
      const actual = await hashFile(join(directory, evidence.relativePath));
      if (
        actual.byteLength !== evidence.byteLength ||
        actual.sha256 !== evidence.sha256
      )
        throw new Error('Legacy recovery evidence failed integrity validation');
    }
    if (childStreams)
      await verifyChildStreamRows(
        join(directory, 'transcripts'),
        transcript.artifacts,
        () => undefined,
        indexedChatIds(indexes),
      );
  }

  private async validate(
    directory: string,
    expectedDigest: string,
  ): Promise<void> {
    const indexes = await this.readIndexes(directory);
    for (const evidence of indexes.recovery.legacyEvidence ?? []) {
      if (!/^recovery-evidence\/\d+\.bin$/.test(evidence.relativePath))
        throw new Error('Invalid legacy evidence path');
      const actual = await hashFile(join(directory, evidence.relativePath));
      if (
        actual.byteLength !== evidence.byteLength ||
        actual.sha256 !== evidence.sha256
      )
        throw new Error('Legacy recovery evidence failed integrity validation');
    }
    const transcript = new ChatTranscriptLog(join(directory, 'transcripts'));
    const digest = createHash('sha256');
    digest.update(JSON.stringify(this.metadata(indexes)));
    for (const tab of [
      ...indexes.live.tabs,
      ...indexes.archive.archived.map((entry) => entry.tab),
    ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      const chatDigest = createHash('sha256');
      let count = 0;
      for await (const message of transcript.iterate(tab.id)) {
        for await (const reference of transcript.artifacts.referenceClosure(
          tab.id,
          message,
        ))
          await transcript.artifacts.verify(tab.id, reference);
        if (message.blocksRef) throw new Error('Block pages require format 4');
        for (const block of message.blocks)
          for (const ref of storedArtifactRefsOf(block))
            if (ref.family === 'visual')
              await transcript.artifacts.verifyArtifact(tab.id, ref);
        chatDigest.update(JSON.stringify(message)).update('\n');
        count += 1;
      }
      if (count !== tab.transcript.committedMessageCount)
        throw new Error('Migrated transcript count mismatch');
      if (
        (await transcript.descriptor(tab.id)).committedByteLength !==
        tab.transcript.committedByteLength
      ) {
        throw new Error('Migrated transcript byte length mismatch');
      }
      digest
        .update(tab.id)
        .update('\0')
        .update(chatDigest.digest('hex'))
        .update('\n');
    }
    if (digest.digest('hex') !== expectedDigest)
      throw new Error('Migrated transcript reconstruction mismatch');
  }

  private metadata(indexes: {
    live: ChatLiveIndex;
    archive: ChatArchiveIndex;
    recovery: ChatRecoveryIndex;
  }): unknown {
    const strip = ({
      transcript: _transcript,
      ...tab
    }: ChatIndexEntry): Omit<PersistedChatTab, 'messages'> => {
      void _transcript;
      return tab;
    };
    return {
      recovery: indexes.recovery,
      live: { ...indexes.live, tabs: indexes.live.tabs.map(strip) },
      archive: {
        ...indexes.archive,
        archived: indexes.archive.archived.map((entry) => ({
          ...entry,
          tab: strip(entry.tab),
        })),
      },
    };
  }

  private async markValidated(manifest: StorageManifest): Promise<void> {
    if (manifest.cleanupComplete) return;
    await writeJson(this.manifestPath, { ...manifest, cleanupComplete: true });
  }

  /**
   * Validated version 2 without a retained copy: the six legacy files go now,
   * through the same contained removal as after format 4. Anything else the
   * legacy folders hold for this scope was copied into the recovery evidence
   * and stays where it is.
   */
  private async cleanup(manifest: StorageManifest): Promise<void> {
    if (manifest.cleanupComplete) return;
    await this.removeLegacyFiles();
    await writeJson(this.manifestPath, { ...manifest, cleanupComplete: true });
  }

  /**
   * Before a scope's authority is removed, remove its legacy files, so a
   * deleted scope can never reopen from them. The user is deleting this
   * scope's chats and its evidence goes in the same step, so files migration
   * neither used nor kept go too. Fails closed on a link or a file outside
   * the scope: nothing is removed and the error says how to fix it.
   */
  public async removeLegacyFilesForDeletion(): Promise<void> {
    const { refused } = await this.removeLegacyFiles({
      allOrNothing: true,
      onlyBuiltOrKept: false,
    });
    if (refused > 0)
      throw classifyError(
        new Error(
          'Chat scope legacy files could not be removed safely; the scope is kept',
        ),
        'external.chat_history_link_outside',
      );
  }

  /**
   * Remove the scope's legacy files and their backups once its format 4 copy
   * has been read back; any other format keeps them. Only the six enumerated
   * paths go, each only while it is a regular file in a folder that resolves
   * inside the scope's own root. A link or anything else is left in place.
   */
  public async completeLegacyCleanup(): Promise<{
    format4: boolean;
    removed: number;
    refused: number;
  }> {
    if ((await this.manifest())?.version !== 4)
      return { format4: false, removed: 0, refused: 0 };
    return { format4: true, ...(await this.removeLegacyFiles()) };
  }

  private async removeLegacyFiles(
    options: { allOrNothing?: boolean; onlyBuiltOrKept?: boolean } = {},
  ): Promise<{
    removed: number;
    refused: number;
  }> {
    let root: string | undefined;
    try {
      root = await realpath(this.workspaceRoot);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    // A family file goes only when migration built the store from those very
    // bytes, or kept a verified copy of them as evidence. A store migrated
    // before that record existed treats every member but the journal's
    // backup, which migration never reads, as built from. Both records are
    // read only once a family file is left, and an evidence copy is hashed
    // only when its recorded hash matches that file's bytes.
    type Recorded = { sha256: string; byteLength: number };
    let consumed:
      | Promise<Array<Recorded & { path: string }> | undefined>
      | undefined;
    let recorded:
      | Promise<Array<Recorded & { relativePath: string }>>
      | undefined;
    const journal = this.legacyPaths[2];
    const unread = new Set(journal === undefined ? [] : [`${journal}.bak`]);
    const eligible: string[] = [];
    let refused = 0;
    for (const path of this.legacyPaths.flatMap((family) => [
      family,
      `${family}.bak`,
    ])) {
      let status: Awaited<ReturnType<typeof lstat>>;
      try {
        status = await lstat(path);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      if (
        !status.isFile() ||
        root === undefined ||
        !(await this.folderInsideRoot(dirname(path), root))
      ) {
        refused += 1;
        continue;
      }
      if (options.onlyBuiltOrKept === false) {
        eligible.push(path);
        continue;
      }
      const bytes = await hashFile(path);
      const same = (copy: { sha256: string; byteLength: number }): boolean =>
        copy.sha256 === bytes.sha256 && copy.byteLength === bytes.byteLength;
      const sources = await (consumed ??= this.legacySources());
      const built =
        sources === undefined
          ? !unread.has(path)
          : sources
              .filter(
                (entry) => entry.path === relativeTo(this.workspaceRoot, path),
              )
              .some(same);
      if (
        built ||
        (await this.evidenceVerified(
          (await (recorded ??= this.evidenceEntries())).filter(same),
        ))
      )
        eligible.push(path);
      else refused += 1;
    }
    if (refused > 0 && options.allOrNothing) return { removed: 0, refused };
    // Every legacy folder inside the scope is synced, not only those this
    // attempt deleted from, so a retry also makes an earlier attempt's
    // deletions durable before anything relies on them.
    const folders: string[] = [];
    for (const folder of new Set(
      this.legacyPaths.map((family) => dirname(family)),
    ))
      if (root !== undefined && (await this.folderInsideRoot(folder, root)))
        folders.push(folder);
    let removed = 0;
    try {
      for (const path of eligible) {
        try {
          await unlink(path);
        } catch (error) {
          if (isMissing(error)) continue;
          throw error;
        }
        removed += 1;
      }
    } finally {
      for (const folder of folders) await fsyncDirectory(folder);
    }
    return { removed, refused };
  }

  /** The consumed-file record migration wrote, or undefined before it existed. */
  private async legacySources(): Promise<
    Array<{ path: string; sha256: string; byteLength: number }> | undefined
  > {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        await readFile(join(this.directory, LEGACY_SOURCES_FILE), 'utf8'),
      );
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.consumed)) return [];
    return parsed.consumed.flatMap((entry: unknown) =>
      isRecord(entry) &&
      typeof entry.path === 'string' &&
      typeof entry.sha256 === 'string' &&
      typeof entry.byteLength === 'number'
        ? [
            {
              path: entry.path,
              sha256: entry.sha256,
              byteLength: entry.byteLength,
            },
          ]
        : [],
    );
  }

  /** The recovery-evidence copies the store's indexes record, unverified. */
  private async evidenceEntries(): Promise<
    Array<{ relativePath: string; sha256: string; byteLength: number }>
  > {
    const entries = new Map<
      string,
      { relativePath: string; sha256: string; byteLength: number }
    >();
    const add = (list: unknown): void => {
      if (!Array.isArray(list)) return;
      for (const entry of list)
        if (
          isRecord(entry) &&
          typeof entry.relativePath === 'string' &&
          /^recovery-evidence\/\d+\.bin$/.test(entry.relativePath) &&
          typeof entry.sha256 === 'string' &&
          typeof entry.byteLength === 'number'
        )
          entries.set(`${entry.relativePath}:${entry.sha256}`, {
            relativePath: entry.relativePath,
            sha256: entry.sha256,
            byteLength: entry.byteLength,
          });
    };
    try {
      add((await this.indexes()).recovery.legacyEvidence);
    } catch {
      // The on-disk index below still names the migration's copies.
    }
    try {
      const recovery: unknown = JSON.parse(
        await readFile(join(this.directory, 'recovery-index.json'), 'utf8'),
      );
      if (isRecord(recovery)) add(recovery.legacyEvidence);
    } catch {
      // No on-disk index: only the store's own indexes count.
    }
    return [...entries.values()];
  }

  /** Whether any of these recorded copies still holds its recorded bytes. */
  private async evidenceVerified(
    candidates: ReadonlyArray<{
      relativePath: string;
      sha256: string;
      byteLength: number;
    }>,
  ): Promise<boolean> {
    for (const entry of candidates) {
      try {
        const copy = await hashFile(join(this.directory, entry.relativePath));
        if (
          copy.sha256 === entry.sha256 &&
          copy.byteLength === entry.byteLength
        )
          return true;
      } catch {
        // A missing or unreadable copy is no copy.
      }
    }
    return false;
  }

  /** The folder is inside the scope root, with no link anywhere between. */
  private async folderInsideRoot(
    folder: string,
    root: string,
  ): Promise<boolean> {
    const relativePath = relativeTo(this.workspaceRoot, folder);
    if (
      relativePath === '..' ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    )
      return false;
    try {
      return (await realpath(folder)) === join(root, relativePath);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }
}
