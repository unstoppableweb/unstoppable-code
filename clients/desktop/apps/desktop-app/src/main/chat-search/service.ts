import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import type { ChildSearchDocumentIdentity } from './child-text';
import type { ChildSearchDirtyNotification } from '../services/chat-state-v2-repository';
import type { ChatTabsWriteDelta } from '../lib/chat-tabs';
import { getStandaloneHistoryStorage } from '../lib/standalone-history';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import { ChatTranscriptIntegrityError } from '../lib/chat-transcript-log';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import type { Dirent } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  createThreadedChatSearchIndexer,
  type ThreadedChatSearchIndexer,
} from './threaded-indexer';
import { BrowserWindow } from 'electron';
import {
  APP_ADVISOR_PROJECT_ID,
  COWORK_HOME_WORKTREE_ID,
  IPC_CHANNELS,
  STANDALONE_CHAT_PROJECT_ID,
  type ChatSearchCatalogEntry,
  type ChatSearchQueryRequest,
  type ChatSearchResult,
  type ChatTabsFile,
  type ArchivedChatsFile,
  type ArchivedContainerManifest,
  type PersistedChatMessage,
  type PersistedChatTab,
  type TrackedPlanReviewStatus,
  type WorkspaceContext,
  type WorkspaceOwnerBinding,
  type WorktreeSummaryData,
} from '@canopy/desktop-shared/types';
import { workspaceOwnerMatchesContext } from '@canopy/execution-engine/lib/workspace-owner';
import {
  getAppManagedChatWorkspaceDir,
  getArchivedContainerManifestPath,
  getArchivedContainerSummaryPath,
  getArchivedContainersRootDir,
  getChatSearchIndexPath,
  getWorkspaceChatArchivesFilePath,
  getWorkspaceChatHistoryDir,
  getWorkspaceChatHistoryRootDir,
  getWorkspaceChatTabsFilePath,
  getWorkspaceDir,
  getWorkspacesRootDir,
  getWorkspaceTrackedPlansFilePath,
} from '../lib/paths';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import { isErrnoException, isRecord } from '../lib/type-guards';
import { validateId } from '../lib/validation';
import { readChatTabsFileForIndex } from '../lib/chat-tabs-reader';
import { readChatArchivesFileForIndex } from '../lib/chat-archives';
import {
  readArchiveMetaForIndex,
  readArchiveSnapshotForIndex,
} from '../lib/standalone-history';
import {
  type ChatSearchIndexer,
  buildChatSearchDoc,
  buildChatChildSearchDoc,
  buildArchivedContainerEntityDoc,
  buildPlanSearchDoc,
  committedTranscriptFingerprint,
  extractChatSearchBody,
  transcriptFingerprint,
  type ChatSearchDoc,
  type ChatSearchSource,
  type SourceFingerprint,
  type TrackedPlanIndexEntry,
} from './indexer';
import { openChatSearchDatabase } from './schema';
import { requireSqliteRow } from './sqlite-rows';
import {
  readArchivedContainerChatArchives,
  getArchivedContainerChatStorage,
  readArchivedContainerChats,
  readArchivedContainerManifest,
  readArchivedContainerTrackedPlans,
} from '../lib/archived-containers';
import { isWorktreeSummaryData } from '../lib/worktree-summary-persistence';
import {
  chatSearchQueryExceedsBodyThreshold,
  mapChatSearchCatalogRow,
  normalizeQueryRequest,
  queryChatSearchDatabase,
} from './query';
import { ChatSearchQueryRunner } from './query-runner';
import { ActiveTurnSearchText } from './active-turn-text';
import type { ActiveTurnDelta } from '../lib/chat-delta-journal/active-turn';
import { sendToWebContents } from '../lib/web-contents-send';
import { readWorkspaceConfigDetailed } from '../lib/workspace-persistence';

const DEFAULT_CATALOG_LIMIT = 2_000;
const DEFAULT_BROADCAST_DEBOUNCE_MS = 50;
const LARGE_QUERY_BODY_THRESHOLD_BYTES = 16 * 1024 * 1024;

class StaleSearchProjectionError extends Error {}

type SourceKind = ChatSearchSource;

const CHAT_SEARCH_SOURCES: readonly ChatSearchSource[] = [
  'live',
  'worktree-archive',
  'cowork-archive',
  'plan',
  'archived-container',
];

function isChatSearchSource(value: unknown): value is ChatSearchSource {
  return (
    typeof value === 'string' &&
    CHAT_SEARCH_SOURCES.some((source) => source === value)
  );
}

const PLAN_REVIEW_STATUSES: readonly TrackedPlanReviewStatus[] = [
  'pending',
  'approved',
  'dismissed',
];

function asPlanReviewStatus(value: unknown): TrackedPlanReviewStatus | null {
  return PLAN_REVIEW_STATUSES.find((status) => status === value) ?? null;
}

interface SourceDescriptor {
  fileKey: string;
  kind: SourceKind;
  projectId: string;
  worktreeId: string;
  worktreeGeneration: number;
  archiveContentEpoch?: number;
  liveContentEpoch?: number;
  chatId?: string;
  fingerprint: SourceFingerprint;
}

/** Called once, without a failure when the update lands, is superseded or is cancelled. */
type PendingUpdateWaiter = (failure?: { error: unknown }) => void;

interface PendingUpdate {
  timer: ReturnType<typeof setTimeout>;
  task: () => Promise<void> | void;
  liveTabsUpdate?: PendingLiveTabsUpdate;
  /** Carried to the update that replaces this one, which covers its changes. */
  waiters: PendingUpdateWaiter[];
}

function settleWaiters(
  waiters: readonly PendingUpdateWaiter[],
  failure?: { error: unknown },
): void {
  for (const waiter of waiters) waiter(failure);
}

interface PendingLiveTabChanges {
  kind: 'delta';
  generation: number;
  contentEpoch: number;
  tabsById: Map<string, PersistedChatTab | null>;
  isSnapshotCurrent?: () => boolean;
  /** Committed revision of the newest snapshot merged in. */
  revision?: number;
}

/**
 * Guards a live source fingerprint. A commit reaches disk before its
 * projection is queued, so a fingerprint taken after indexing can already
 * cover a newer commit; recorded, it would let the startup scan skip that
 * commit once quit or a crash drops its update.
 */
interface LiveFingerprintFence {
  contentEpoch: number;
  /**
   * False once a newer commit is published; absent when the caller cannot
   * tell. A commit is durable before it is published, so `revision` closes
   * the gap between the two.
   */
  isSnapshotCurrent?: () => boolean;
  /**
   * Committed revision of the indexed snapshot. The fingerprint is recorded
   * only while it is still the scope's committed revision, read after the
   * fingerprint. Absent for a caller without one, such as a legacy file.
   */
  revision?: number;
  /** Taken before a reread, so the indexed content is at least as new. */
  fingerprint?: SourceFingerprint | null;
}

/**
 * Records that every stored live fingerprint passed the revision fence. Older
 * builds recorded fingerprints without it, so a scan distrusts theirs once.
 */
const LIVE_FINGERPRINT_FENCE_METADATA_KEY = 'live_fingerprint_fence';

/** An archive or restore reported outside a commit has no revision to check. */
const UNVERIFIED_SNAPSHOT = (): boolean => false;

/** Read behind every commit admitted before the call; undefined when unreadable. */
async function readCommittedLiveRevision(
  projectId: string,
  worktreeId: string,
): Promise<number | undefined> {
  try {
    const { getChatStateService } =
      await import('../services/chat-state-service');
    return await getChatStateService().getCommittedRevision({
      projectId,
      worktreeId,
    });
  } catch {
    return undefined;
  }
}

interface PendingFullLiveTabsUpdate {
  kind: 'full';
  generation: number;
  contentEpoch: number;
  /** Absent when the update rereads the scope as it runs. */
  data?: ChatTabsFile;
  isSnapshotCurrent?: () => boolean;
}

type PendingLiveTabsUpdate = PendingLiveTabChanges | PendingFullLiveTabsUpdate;

type SearchWorkspaceOwner = Pick<
  WorkspaceOwnerBinding,
  'type' | 'organizationId'
>;
/**
 * `undefined` is a Personal workspace; `null` means no workspace config exists.
 * Scoped search hides the latter because its owner cannot be established. The
 * intentional App Advisor exception is handled explicitly by project id.
 */
type ResolveWorkspaceOwner = (
  workspaceId: string,
) => Promise<SearchWorkspaceOwner | undefined | null>;

export interface ChatSearchServiceOptions {
  dbPath?: string;
  /** Explicit deterministic adapter for repository/unit tests. Production always uses the thread. */
  indexerFactory?: (db: DatabaseSync) => ChatSearchIndexer;
  /** Creates the worker-backed indexer; replaceable so tests can fail it. */
  threadedIndexerFactory?: (dbPath: string) => ThreadedChatSearchIndexer;
  debounceMs?: number;
  /**
   * The window a parent chat's child stream changes collect in before their
   * search documents are reconciled. Defaults to `debounceMs` when that is
   * set, else {@link CHILD_SEARCH_WINDOW_MS}.
   */
  childSearchWindowMs?: number;
  broadcastDebounceMs?: number;
  broadcastUpdated?: () => void;
  /**
   * Aggregate ranked-body size that routes a query to the utility worker.
   * Overridable so tests can exercise the worker and recovery paths without
   * materializing multi-megabyte transcripts.
   */
  largeQueryBodyThresholdBytes?: number;
  /** Injectable authoritative owner lookup for context-scoping tests. */
  resolveWorkspaceOwner?: ResolveWorkspaceOwner;
}

async function resolvePersistedWorkspaceOwner(
  workspaceId: string,
): Promise<WorkspaceOwnerBinding | undefined | null> {
  if (workspaceId === APP_ADVISOR_PROJECT_ID) return null;
  const { config, authority, ownerMalformed } =
    await readWorkspaceConfigDetailed(workspaceId);
  return authority !== 'ok' || ownerMalformed ? null : config.owner;
}

function broadcastChatSearchUpdated(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      sendToWebContents(window.webContents, IPC_CHANNELS.chatSearchUpdated);
    }
  }
}

export { parseChatSearchSnippet, sanitizeChatSearchQuery } from './query';

async function safeReadDir(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return [];
    }
    throw error;
  }
}

async function readArchivedSummaryForIndex(
  projectId: string,
  containerId: string,
): Promise<WorktreeSummaryData | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(
        getArchivedContainerSummaryPath(projectId, containerId),
        'utf8',
      ),
    );
    if (
      isRecord(parsed) &&
      'summary' in parsed &&
      isWorktreeSummaryData(parsed.summary)
    ) {
      return parsed.summary;
    }
  } catch {
    // Captured summaries are optional derived context for search.
  }
  return null;
}

async function safeFingerprint(
  path: string,
): Promise<SourceFingerprint | null> {
  try {
    const info = await stat(path);
    return {
      mtimeMs: Math.trunc(info.mtimeMs),
      sizeBytes: info.size,
    };
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function coworkArchiveFingerprint(
  directory: string,
): Promise<SourceFingerprint | null> {
  const fingerprints = await Promise.all(
    [
      directory,
      join(directory, 'meta.json'),
      join(directory, 'conversation.json'),
    ].map(safeFingerprint),
  );
  const existing = fingerprints.filter(
    (value): value is SourceFingerprint => value !== null,
  );
  if (existing.length === 0) return null;
  return {
    mtimeMs: Math.max(...existing.map((value) => value.mtimeMs)),
    sizeBytes: existing.reduce((total, value) => total + value.sizeBytes, 0),
  };
}

function yieldToMainLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function getWorkerDatabasePath(database: DatabaseSync): string | null {
  const rows: unknown[] = database.prepare('PRAGMA database_list').all();
  const main = rows
    .map((row) => requireSqliteRow(row))
    .find((row) => row.name === 'main');
  return typeof main?.file === 'string' && main.file.length > 0
    ? main.file
    : null;
}

/**
 * Strict tracked-plans reader for the index's own scan path. Deliberately
 * does not import `plan-persistence` (which hooks back into this service on
 * write) and validates only the fields the index consumes. File-level parse
 * and schema failures abort indexing so retained rows are not erased, while
 * individually malformed plan entries are skipped.
 */
async function readTrackedPlansForIndex(
  filePath: string,
): Promise<TrackedPlanIndexEntry[]> {
  const contents = await readFile(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error(`Invalid tracked plans JSON: ${filePath}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Invalid tracked plans file: ${filePath}`);
  }
  const plansValue: unknown = parsed.plans;
  if (!Array.isArray(plansValue)) {
    throw new Error(`Invalid tracked plans file: ${filePath}`);
  }
  const plans: unknown[] = plansValue;
  const entries: TrackedPlanIndexEntry[] = [];
  for (const candidate of plans) {
    if (!isRecord(candidate)) continue;
    const plan = candidate;
    if (
      typeof plan.id !== 'string' ||
      typeof plan.title !== 'string' ||
      typeof plan.content !== 'string'
    ) {
      continue;
    }
    const reviewStatus = asPlanReviewStatus(plan.reviewStatus);
    entries.push({
      id: plan.id,
      title: plan.title,
      content: plan.content,
      ...(typeof plan.hidden === 'boolean' ? { hidden: plan.hidden } : {}),
      ...(typeof plan.createdAt === 'string'
        ? { createdAt: plan.createdAt }
        : {}),
      ...(typeof plan.updatedAt === 'string'
        ? { updatedAt: plan.updatedAt }
        : {}),
      ...(reviewStatus ? { reviewStatus } : {}),
    });
  }
  return entries;
}

/** A transcript projected through a captured preview. */
interface TranscriptPreviewProjection {
  descriptor: NonNullable<PersistedChatTab['transcript']>;
  /** Committed-prefix text; undefined when only the active sidecar was read. */
  committedBody: string | undefined;
  /** Text of the active sidecar's in-flight rows. */
  activeBody: string;
  /** Each in-flight row's text, in order, when the read included them. */
  activeRows?: Array<{ id: string; text: string }>;
  /** The in-flight rows came from a delta journal's in-memory projection. */
  journalProjected?: boolean;
}

function staleProjectionGuard(isCurrent?: () => boolean): () => void {
  return (): void => {
    if (isCurrent && !isCurrent())
      throw new StaleSearchProjectionError('Search projection was superseded');
  };
}

function withTranscriptSplit(
  doc: ChatSearchDoc,
  activeBody: string | undefined,
  committedFingerprint: string | undefined,
): ChatSearchDoc {
  return {
    ...doc,
    ...(activeBody ? { activeBody } : {}),
    ...(committedFingerprint === undefined ? {} : { committedFingerprint }),
  };
}

/**
 * Indexes committed text as the body and in-flight text as a separate row, so
 * an active-sidecar revision can later replace only the in-flight row.
 */
function buildPreviewSearchDoc(
  projectId: string,
  worktreeId: string,
  source: ChatSearchSource,
  tab: PersistedChatTab,
  projection: TranscriptPreviewProjection,
  archivedAt?: string,
  expiresAt?: string,
): ChatSearchDoc {
  return withTranscriptSplit(
    buildChatSearchDoc(
      projectId,
      worktreeId,
      source,
      { ...tab, transcript: projection.descriptor },
      archivedAt,
      expiresAt,
      projection.committedBody ?? '',
    ),
    projection.activeBody,
    committedTranscriptFingerprint(projection.descriptor),
  );
}

/** First wait before replacing a failed index worker; doubles per failure. */
export const CHAT_SEARCH_INDEXER_RECOVERY_DELAY_MS = 30_000;
const CHAT_SEARCH_INDEXER_RECOVERY_MAX_DELAY_MS = 10 * 60_000;

/** Bounded retries for a child set that changed while it was staged. */
const CHILD_RECONCILE_RETRIES = 2;
/**
 * Delegates commit child rows many times a second, and each reconcile takes
 * several turns of the scope's storage lease, so a parent's changes collect
 * for this long: child search results lag by up to this window.
 */
export const CHILD_SEARCH_WINDOW_MS = 2_000;
/** SQL narrowing a catalog page to the given chats, bound after the time. */
function chatIdFilter(chatIds: readonly string[] | undefined): string {
  return chatIds === undefined
    ? ''
    : ` AND chat_id IN (${chatIds.map(() => '?').join(', ')})`;
}

export class ChatSearchService {
  private db: DatabaseSync | null = null;
  private indexer: ChatSearchIndexer | ThreadedChatSearchIndexer | null = null;
  private readonly indexerFactory: ChatSearchServiceOptions['indexerFactory'];
  private readonly threadedIndexerFactory: (
    dbPath: string,
  ) => ThreadedChatSearchIndexer;
  private indexerRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private indexerRecoveryAttempts = 0;
  private readonly hiddenLiveScopes = new Set<string>();
  private readonly dbPath: string;
  private readonly debounceMs: number;
  private readonly childSearchWindowMs: number;
  private readonly broadcastDebounceMs: number;
  private readonly broadcastUpdated: () => void;
  private readonly pendingUpdates = new Map<string, PendingUpdate>();
  /** Live-tab updates past their debounce whose task is still running. */
  private readonly runningLiveUpdates = new Map<string, PendingUpdate>();
  /**
   * Live update keys whose whole scope this process has indexed. Only these
   * let a per-chat update record the source fingerprint; elsewhere it would
   * hide unindexed chats from the next scan.
   */
  private readonly syncedLiveScopes = new Set<string>();
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private indexRevision = 0;
  private initialScanPromise: Promise<void> | null = null;
  private activeScanPromise: Promise<void> | null = null;
  private activeScanSourceKeys: Set<string> | null = null;
  private closed = false;
  private readonly childReads = new Set<{
    projectId: string;
    worktreeId: string;
    controller: AbortController;
  }>();
  private readonly deletedWorkspaces = new Set<string>();
  private readonly deletedWorktrees = new Set<string>();
  private readonly deletedCoworkArchives = new Set<string>();
  private readonly worktreeGenerations = new Map<string, number>();
  private readonly liveContentEpochs = new Map<string, number>();
  private readonly archiveContentEpochs = new Map<string, number>();
  private queryRunner: ChatSearchQueryRunner | null = null;
  private workerDatabasePath: string | null = null;
  /** In-flight row text of live delta-journal chats (`active-turn-text.ts`). */
  private readonly activeTurnText = new ActiveTurnSearchText((message) =>
    extractChatSearchBody([message]),
  );
  private readonly largeQueryBodyThresholdBytes: number;
  private readonly resolveWorkspaceOwner: ResolveWorkspaceOwner;

  constructor(options: ChatSearchServiceOptions = {}) {
    this.indexerFactory = options.indexerFactory;
    this.threadedIndexerFactory =
      options.threadedIndexerFactory ?? createThreadedChatSearchIndexer;
    this.dbPath = options.dbPath ?? getChatSearchIndexPath();
    this.largeQueryBodyThresholdBytes =
      options.largeQueryBodyThresholdBytes ?? LARGE_QUERY_BODY_THRESHOLD_BYTES;
    this.resolveWorkspaceOwner =
      options.resolveWorkspaceOwner ?? resolvePersistedWorkspaceOwner;
    this.debounceMs = options.debounceMs ?? 500;
    this.childSearchWindowMs =
      options.childSearchWindowMs ??
      options.debounceMs ??
      CHILD_SEARCH_WINDOW_MS;
    this.broadcastDebounceMs =
      options.broadcastDebounceMs ?? DEFAULT_BROADCAST_DEBOUNCE_MS;
    this.broadcastUpdated =
      options.broadcastUpdated ?? broadcastChatSearchUpdated;
  }

  ensureInitialScan(): void {
    if (this.closed || this.initialScanPromise !== null) return;
    const scan = yieldToMainLoop().then(() => this.scanAllSources());
    this.initialScanPromise = scan;
    void scan.catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.error('Chat search initial scan failed:', error);
      this.recoverFailedIndexer();
      if (this.initialScanPromise === scan) this.initialScanPromise = null;
    });
  }

  async waitForInitialScan(): Promise<void> {
    await this.initialScanPromise;
  }

  getIndexRevision(): number {
    return this.indexRevision;
  }

  async scanAllSources(): Promise<void> {
    if (this.closed) return;
    if (this.activeScanPromise) return this.activeScanPromise;
    const scan = this.performFullScan();
    this.activeScanPromise = scan;
    try {
      await scan;
    } finally {
      if (this.activeScanPromise === scan) this.activeScanPromise = null;
    }
  }

  /**
   * The newest catalog rows, or with `chatIds` only those chats' rows (live
   * and archived copies) however old they are, under the same visibility.
   */
  getCatalog(
    limit = DEFAULT_CATALOG_LIMIT,
    chatIds?: readonly string[],
  ): ChatSearchCatalogEntry[] {
    if (this.closed) return [];
    const normalizedLimit = Number.isFinite(limit)
      ? Math.max(0, Math.trunc(limit))
      : DEFAULT_CATALOG_LIMIT;
    if (normalizedLimit === 0 || chatIds?.length === 0) return [];
    const database = this.getDatabase();
    const now = Date.now();
    return this.collectVisiblePage(normalizedLimit, (offset) => {
      const rows: unknown[] = database
        .prepare(
          `SELECT doc_id, project_id, worktree_id, chat_id, source, title,
                  document_kind, description, provider_type, updated_at, archived_at,
                  expires_at, message_count, review_status
           FROM chat_docs
           WHERE document_kind != 'chat-child' AND (expires_at IS NULL OR expires_at > ?)${chatIdFilter(chatIds)}
           ORDER BY updated_at DESC
           LIMIT ? OFFSET ?`,
        )
        .all(now, ...(chatIds ?? []), normalizedLimit, offset);
      return rows.map((row) => mapChatSearchCatalogRow(requireSqliteRow(row)));
    });
  }

  async getCatalogScoped(
    context: WorkspaceContext | undefined,
    limit = DEFAULT_CATALOG_LIMIT,
    linkedPersonalWorkspaceIds: readonly string[] = [],
    chatIds?: readonly string[],
  ): Promise<ChatSearchCatalogEntry[]> {
    if (context === undefined) return this.getCatalog(limit, chatIds);
    if (this.closed) return [];
    const normalizedLimit = Number.isFinite(limit)
      ? Math.max(0, Math.trunc(limit))
      : DEFAULT_CATALOG_LIMIT;
    if (normalizedLimit === 0 || chatIds?.length === 0) return [];
    const database = this.getDatabase();
    const now = Date.now();
    const isVisible = this.createContextVisibilityPredicate(
      context,
      linkedPersonalWorkspaceIds,
    );
    return this.collectVisiblePageAsync(
      normalizedLimit,
      (offset) => {
        const rows: unknown[] = database
          .prepare(
            `SELECT doc_id, project_id, worktree_id, chat_id, source, title,
                    document_kind, description, provider_type, updated_at, archived_at,
                    expires_at, message_count, review_status
             FROM chat_docs
             WHERE document_kind != 'chat-child' AND (expires_at IS NULL OR expires_at > ?)${chatIdFilter(chatIds)}
             ORDER BY updated_at DESC
             LIMIT ? OFFSET ?`,
          )
          .all(now, ...(chatIds ?? []), normalizedLimit, offset);
        return Promise.resolve(
          rows.map((row) => mapChatSearchCatalogRow(requireSqliteRow(row))),
        );
      },
      isVisible,
    );
  }

  query(request: ChatSearchQueryRequest): ChatSearchResult[] {
    if (this.closed) return [];
    const normalized = normalizeQueryRequest(request);
    if (!normalized) return [];
    const database = this.getDatabase();
    const now = Date.now();
    const pageRequest = { ...request, limit: normalized.limit };
    return this.collectVisiblePage(normalized.limit, (offset) =>
      queryChatSearchDatabase(database, pageRequest, now, offset),
    );
  }

  async queryResponsive(
    request: ChatSearchQueryRequest,
    context?: WorkspaceContext,
    linkedPersonalWorkspaceIds: readonly string[] = [],
  ): Promise<ChatSearchResult[]> {
    if (this.closed) return [];
    const database = this.getDatabase();
    const normalized = normalizeQueryRequest(request);
    if (!normalized) return [];
    const pageRequest = { ...request, limit: normalized.limit };
    const hasVisibilityExclusions =
      this.deletedWorkspaces.size > 0 ||
      this.deletedWorktrees.size > 0 ||
      this.deletedCoworkArchives.size > 0 ||
      this.hiddenLiveScopes.size > 0;
    const exceedsWorkerThreshold =
      hasVisibilityExclusions ||
      chatSearchQueryExceedsBodyThreshold(
        database,
        pageRequest,
        this.largeQueryBodyThresholdBytes,
      );
    if (!exceedsWorkerThreshold || this.workerDatabasePath === null) {
      // The recovery database is in-memory and has no path a utility process
      // can reopen. Preserve its populated results on the active connection;
      // file-backed oversized queries still use worker isolation below.
      const now = Date.now();
      if (context !== undefined) {
        return this.collectVisiblePageAsync(
          normalized.limit,
          (offset) =>
            Promise.resolve(
              queryChatSearchDatabase(database, pageRequest, now, offset),
            ),
          this.createContextVisibilityPredicate(
            context,
            linkedPersonalWorkspaceIds,
          ),
        );
      }
      return this.collectVisiblePage(normalized.limit, (offset) =>
        queryChatSearchDatabase(database, pageRequest, now, offset),
      );
    }
    this.queryRunner ??= new ChatSearchQueryRunner();
    const queryRunner = this.queryRunner;
    const workerDatabasePath = this.workerDatabasePath;
    try {
      const now = Date.now();
      return await this.collectVisiblePageAsync(
        normalized.limit,
        (offset) =>
          queryRunner.run(workerDatabasePath, pageRequest, now, offset),
        context === undefined
          ? undefined
          : this.createContextVisibilityPredicate(
              context,
              linkedPersonalWorkspaceIds,
            ),
      );
    } catch (error) {
      // `close()` cancels in-flight worker queries. Re-running an oversized
      // projection in-process during shutdown would block the main loop while
      // quitting and race `close()` closing `this.db`, so a cancellation
      // resolves as empty instead of being treated as a worker failure.
      if (this.closed) return [];
      // A missing, timed-out, or failed utility process degrades this one
      // oversized response instead of re-running the expensive SQLite snippet
      // projection synchronously on Electron main. A later settled query gets
      // a fresh one-shot worker attempt through the reusable runner. The
      // failure is still logged: an empty response reads as "no matches",
      // which once hid every oversized query throwing on this path.
      // eslint-disable-next-line no-console
      console.error('Chat search query failed:', error);
      return [];
    }
  }

  indexLiveTabs(
    projectId: string,
    worktreeId: string,
    data: ChatTabsFile,
  ): void {
    this.queueLiveTabs(projectId, worktreeId, data);
  }

  indexLiveTabChanges(
    projectId: string,
    worktreeId: string,
    data: ChatTabsFile,
    changedTabIds: readonly string[],
    removedTabIds: readonly string[],
  ): void {
    this.queueLiveTabChanges(
      projectId,
      worktreeId,
      data,
      changedTabIds,
      removedTabIds,
    );
  }

  /**
   * Indexes a committed chat materialization: the changed and removed tabs
   * when a delta is known, else the whole scope. Resolves once the update is
   * indexed, superseded by a newer one or cancelled with its scope; rejects
   * when indexing fails, so the caller can retry. `isSnapshotCurrent` turns
   * false once a newer commit is published, which withholds the fingerprint.
   */
  projectLiveTabs(
    projectId: string,
    worktreeId: string,
    data: ChatTabsFile,
    delta: ChatTabsWriteDelta | undefined,
    isSnapshotCurrent?: () => boolean,
  ): Promise<void> {
    return new Promise<{ error: unknown } | undefined>((waiter) => {
      if (delta) {
        this.queueLiveTabChanges(
          projectId,
          worktreeId,
          data,
          delta.changedTabIds,
          delta.removedTabIds,
          waiter,
          isSnapshotCurrent,
        );
      } else {
        this.queueLiveTabs(
          projectId,
          worktreeId,
          data,
          waiter,
          isSnapshotCurrent,
        );
      }
    }).then((failure) => {
      if (failure) throw failure.error;
    });
  }

  private queueLiveTabs(
    projectId: string,
    worktreeId: string,
    data: ChatTabsFile,
    waiter?: PendingUpdateWaiter,
    isSnapshotCurrent?: () => boolean,
  ): void {
    this.queueFullLiveUpdate(
      this.normalizeLiveScope(projectId, worktreeId),
      data,
      waiter,
      isSnapshotCurrent,
    );
  }

  /** Replaces the scope's live documents from `data`, else from a reread. */
  private queueFullLiveUpdate(
    scope: { projectId: string; worktreeId: string },
    data: ChatTabsFile | undefined,
    waiter?: PendingUpdateWaiter,
    isSnapshotCurrent?: () => boolean,
  ): void {
    this.reactivateScope(scope.projectId, scope.worktreeId);
    const generation = this.worktreeGeneration(
      scope.projectId,
      scope.worktreeId,
    );
    const contentEpoch = this.advanceLiveContentEpoch(
      scope.projectId,
      scope.worktreeId,
    );
    const fileKey = this.liveFilePath(scope.projectId, scope.worktreeId);
    this.activeScanSourceKeys?.add(fileKey);
    const updateKey = this.liveUpdateKey(scope.projectId, scope.worktreeId);
    // The whole scope covers whatever a superseded running update left.
    const takenOver = this.takeOverRunningLiveUpdate(updateKey, generation);
    const isCurrent = (): boolean =>
      !this.closed &&
      this.isWorktreeGenerationCurrent(
        scope.projectId,
        scope.worktreeId,
        generation,
      ) &&
      this.isLiveContentEpochCurrent(
        scope.projectId,
        scope.worktreeId,
        contentEpoch,
      );
    this.enqueue(
      updateKey,
      () =>
        this.trackLiveScopeSync(updateKey, async () => {
          if (!isCurrent()) return;
          const rereadFingerprint =
            data === undefined
              ? await this.sourceFingerprint(
                  fileKey,
                  scope.projectId,
                  scope.worktreeId,
                )
              : undefined;
          const scopeData =
            data ??
            (await readChatTabsFileForIndex(scope.projectId, scope.worktreeId));
          if (!isCurrent()) return;
          await this.replaceLiveScope(
            scope.projectId,
            scope.worktreeId,
            scopeData,
            contentEpoch,
          );
          if (!isCurrent()) return;
          this.syncedLiveScopes.add(updateKey);
          await this.refreshFingerprint(
            fileKey,
            scope.projectId,
            scope.worktreeId,
            generation,
            undefined,
            {
              contentEpoch,
              isSnapshotCurrent,
              revision: data?.revision,
              ...(rereadFingerprint === undefined
                ? {}
                : { fingerprint: rereadFingerprint }),
            },
          );
        }),
      { kind: 'full', generation, contentEpoch, data, isSnapshotCurrent },
      waiter,
      takenOver?.waiters,
    );
  }

  /** A failed live update leaves its scope partly indexed. */
  private async trackLiveScopeSync(
    updateKey: string,
    task: () => Promise<void>,
  ): Promise<void> {
    try {
      await task();
    } catch (error) {
      if (!(error instanceof StaleSearchProjectionError)) {
        this.syncedLiveScopes.delete(updateKey);
      }
      throw error;
    }
  }

  private queueLiveTabChanges(
    projectId: string,
    worktreeId: string,
    data: ChatTabsFile,
    changedTabIds: readonly string[],
    removedTabIds: readonly string[],
    waiter?: PendingUpdateWaiter,
    isSnapshotCurrent?: () => boolean,
  ): void {
    if (changedTabIds.length === 0 && removedTabIds.length === 0) {
      waiter?.();
      return;
    }
    const scope = this.normalizeLiveScope(projectId, worktreeId);
    this.reactivateScope(scope.projectId, scope.worktreeId);
    const tabs = new Map(data.tabs.map((tab) => [tab.id, tab]));
    const entries = new Map<string, PersistedChatTab | null>();
    for (const chatId of changedTabIds) {
      const tab = tabs.get(chatId);
      if (tab && (tab.kind ?? 'chat') === 'chat') entries.set(chatId, tab);
    }
    for (const chatId of removedTabIds) entries.set(chatId, null);
    this.queueLiveTabEntries(scope, entries, {
      wholeScope: (): ChatTabsFile => data,
      // `data` holds the newest state of chats a superseded run had left.
      latestTab: (chatId) => {
        const tab = tabs.get(chatId);
        if (!tab) return null;
        return (tab.kind ?? 'chat') === 'chat' ? tab : undefined;
      },
      waiter,
      isSnapshotCurrent,
      revision: data.revision,
    });
  }

  /**
   * Merges live-chat upserts (a tab) and deletions (`null`) into the scope's
   * pending update. A pending or running whole-scope update is re-queued from
   * `wholeScope(base)` instead, or rereads the scope when that has no base.
   * A superseded running update stops at its next content-epoch check, so
   * this one takes over its waiters and its chats, resolved through
   * `latestTab` (`undefined` skips one). `uncommitted` entries have no
   * revision: merged, they keep the update's fence; alone, they withhold the
   * fingerprint.
   */
  private queueLiveTabEntries(
    scope: { projectId: string; worktreeId: string },
    entries: ReadonlyMap<string, PersistedChatTab | null>,
    options: {
      wholeScope: (base: ChatTabsFile | undefined) => ChatTabsFile | undefined;
      latestTab: (
        chatId: string,
        superseded: PersistedChatTab | null,
      ) => PersistedChatTab | null | undefined;
      waiter?: PendingUpdateWaiter;
      isSnapshotCurrent?: () => boolean;
      revision?: number;
      uncommitted?: true;
    },
  ): void {
    const generation = this.worktreeGeneration(
      scope.projectId,
      scope.worktreeId,
    );
    const contentEpoch = this.advanceLiveContentEpoch(
      scope.projectId,
      scope.worktreeId,
    );
    const fileKey = this.liveFilePath(scope.projectId, scope.worktreeId);
    this.activeScanSourceKeys?.add(fileKey);
    const updateKey = this.liveUpdateKey(scope.projectId, scope.worktreeId);
    const full = this.currentFullLiveUpdate(updateKey, generation);
    if (full) {
      this.queueFullLiveUpdate(
        scope,
        options.wholeScope(full.data),
        options.waiter,
        // Like a delta merge, an uncommitted change keeps the base's check.
        options.isSnapshotCurrent ??
          (options.uncommitted ? full.isSnapshotCurrent : undefined),
      );
      return;
    }
    const pending = this.pendingUpdates.get(updateKey)?.liveTabsUpdate;
    const changes =
      pending?.kind === 'delta' && pending.generation === generation
        ? pending
        : {
            kind: 'delta' as const,
            generation,
            contentEpoch,
            tabsById: new Map<string, PersistedChatTab | null>(),
            ...(options.uncommitted
              ? { isSnapshotCurrent: UNVERIFIED_SNAPSHOT }
              : {}),
          };
    changes.contentEpoch = contentEpoch;
    // A merge without a currency check keeps the earlier one: withholding a
    // fingerprint only costs a rescan.
    changes.isSnapshotCurrent =
      options.isSnapshotCurrent ?? changes.isSnapshotCurrent;
    changes.revision = options.revision ?? changes.revision;
    const takenOver = this.takeOverRunningLiveUpdate(updateKey, generation);
    if (takenOver?.update.kind === 'delta') {
      for (const [chatId, superseded] of Array.from(
        takenOver.update.tabsById.entries(),
      )) {
        if (changes.tabsById.has(chatId)) continue;
        const tab = options.latestTab(chatId, superseded);
        if (tab !== undefined) changes.tabsById.set(chatId, tab);
      }
    }
    entries.forEach((tab, chatId) => changes.tabsById.set(chatId, tab));
    this.enqueue(
      updateKey,
      () =>
        this.trackLiveScopeSync(updateKey, () =>
          this.applyLiveTabChanges(scope, generation, changes, fileKey),
        ),
      changes,
      options.waiter,
      takenOver?.waiters,
    );
  }

  /** The scope's pending whole-scope update, else its running one. */
  private currentFullLiveUpdate(
    key: string,
    generation: number,
  ): PendingFullLiveTabsUpdate | undefined {
    const pending = this.pendingUpdates.get(key)?.liveTabsUpdate;
    if (pending?.generation === generation) {
      return pending.kind === 'full' ? pending : undefined;
    }
    const running = this.runningLiveUpdates.get(key)?.liveTabsUpdate;
    return running?.kind === 'full' && running.generation === generation
      ? running
      : undefined;
  }

  private async applyLiveTabChanges(
    scope: { projectId: string; worktreeId: string },
    generation: number,
    changes: PendingLiveTabChanges,
    fileKey: string,
  ): Promise<void> {
    const isCurrent = (): boolean =>
      this.isWorktreeGenerationCurrent(
        scope.projectId,
        scope.worktreeId,
        generation,
      ) &&
      this.isLiveContentEpochCurrent(
        scope.projectId,
        scope.worktreeId,
        changes.contentEpoch,
      );
    if (!isCurrent()) return;
    const indexer = this.getIndexer();
    for (const [chatId, tab] of Array.from(changes.tabsById.entries())) {
      await yieldToEventLoop();
      if (!isCurrent()) return;
      if (tab) {
        await this.upsertLiveChat(
          scope.projectId,
          scope.worktreeId,
          tab,
          changes.contentEpoch,
        );
      } else {
        this.activeTurnText.delete(
          `${scope.projectId}/${scope.worktreeId}/${chatId}/live`,
        );
        await indexer.deleteChatDoc(
          scope.projectId,
          scope.worktreeId,
          chatId,
          'live',
        );
      }
    }
    if (
      !isCurrent() ||
      !this.syncedLiveScopes.has(
        this.liveUpdateKey(scope.projectId, scope.worktreeId),
      )
    ) {
      return;
    }
    await this.refreshFingerprint(
      fileKey,
      scope.projectId,
      scope.worktreeId,
      generation,
      undefined,
      {
        contentEpoch: changes.contentEpoch,
        isSnapshotCurrent: changes.isSnapshotCurrent,
        revision: changes.revision,
      },
    );
  }

  /**
   * A live-tabs update queued after `key`'s running one advances the content
   * epoch, which stops the running one at its next check. The new update
   * takes over its unfinished chats and its waiters, so they settle with it.
   */
  private takeOverRunningLiveUpdate(
    key: string,
    generation: number,
  ):
    | { update: PendingLiveTabsUpdate; waiters: PendingUpdateWaiter[] }
    | undefined {
    const running = this.runningLiveUpdates.get(key);
    if (!running?.liveTabsUpdate) return undefined;
    this.runningLiveUpdates.delete(key);
    if (running.liveTabsUpdate.generation !== generation) return undefined;
    return {
      update: running.liveTabsUpdate,
      waiters: running.waiters.splice(0),
    };
  }

  worktreeChatArchived(
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): void {
    this.indexWorktreeArchives(projectId, worktreeId);
    this.queueArchivedLiveChat(projectId, worktreeId, chatId);
  }

  /** Merged into the live update, so other chats' pending changes still land. */
  private queueArchivedLiveChat(
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): void {
    this.queueLiveTabEntries(
      { projectId, worktreeId },
      new Map([[chatId, null]]),
      {
        wholeScope: (data) =>
          data && {
            ...data,
            tabs: data.tabs.filter((tab) => tab.id !== chatId),
          },
        latestTab: (_chatId, superseded) => superseded,
        uncommitted: true,
      },
    );
  }

  worktreeChatRestored(
    projectId: string,
    worktreeId: string,
    tab: PersistedChatTab,
  ): void {
    this.reactivateScope(projectId, worktreeId);
    this.indexWorktreeArchives(projectId, worktreeId);
    this.queueLiveTabEntries(
      { projectId, worktreeId },
      new Map([[tab.id, tab]]),
      {
        wholeScope: (data) =>
          data && {
            ...data,
            tabs: [...data.tabs.filter((other) => other.id !== tab.id), tab],
          },
        latestTab: (_chatId, superseded) => superseded,
        uncommitted: true,
      },
    );
  }

  indexWorktreeArchives(projectId: string, worktreeId: string): void {
    this.reactivateScope(projectId, worktreeId);
    const generation = this.worktreeGeneration(projectId, worktreeId);
    const contentEpoch = this.advanceArchiveContentEpoch(projectId, worktreeId);
    this.activeScanSourceKeys?.add(
      this.worktreeArchiveFilePath(projectId, worktreeId),
    );
    this.enqueue(`archive:${projectId}/${worktreeId}`, async () => {
      if (
        !this.isWorktreeGenerationCurrent(projectId, worktreeId, generation) ||
        !this.isArchiveContentEpochCurrent(projectId, worktreeId, contentEpoch)
      ) {
        return;
      }
      const fileKey = this.worktreeArchiveFilePath(projectId, worktreeId);
      const data = await readChatArchivesFileForIndex(projectId, worktreeId);
      if (
        this.closed ||
        !this.isWorktreeGenerationCurrent(projectId, worktreeId, generation) ||
        !this.isArchiveContentEpochCurrent(projectId, worktreeId, contentEpoch)
      ) {
        return;
      }
      await this.replaceArchiveScope(projectId, worktreeId, data, contentEpoch);
      await this.refreshFingerprint(
        fileKey,
        projectId,
        worktreeId,
        generation,
        contentEpoch,
      );
    });
  }

  /**
   * Debounced tracked-plans reindex for one worktree. `plans` is the freshly
   * written file content when the caller has it (the persistence write hook);
   * omitted, the file is re-read from disk (scan path).
   */
  indexWorktreePlans(
    projectId: string,
    worktreeId: string,
    plans?: readonly TrackedPlanIndexEntry[],
  ): void {
    this.reactivateScope(projectId, worktreeId);
    const generation = this.worktreeGeneration(projectId, worktreeId);
    const fileKey = this.plansFilePath(projectId, worktreeId);
    this.activeScanSourceKeys?.add(fileKey);
    this.enqueue(`plans:${projectId}/${worktreeId}`, async () => {
      if (
        !this.isWorktreeGenerationCurrent(projectId, worktreeId, generation)
      ) {
        return;
      }
      const entries = plans ?? (await readTrackedPlansForIndex(fileKey));
      if (
        this.closed ||
        !this.isWorktreeGenerationCurrent(projectId, worktreeId, generation)
      ) {
        return;
      }
      await this.getIndexer().replaceWorktreePlans(
        projectId,
        worktreeId,
        entries,
      );
      await this.refreshFingerprint(fileKey, projectId, worktreeId, generation);
    });
  }

  async worktreeContainerArchived(
    projectId: string,
    containerId: string,
  ): Promise<void> {
    this.reactivateScope(projectId, containerId);
    this.hiddenLiveScopes.add(`${projectId}/${containerId}`);
    this.advanceWorktreeGeneration(projectId, containerId);
    this.cancelPending(
      (key) =>
        key === this.liveUpdateKey(projectId, containerId) ||
        key === `archive:${projectId}/${containerId}` ||
        key === `plans:${projectId}/${containerId}` ||
        key === `archived-container:${projectId}/${containerId}`,
    );
    const indexer = this.getIndexer();
    await indexer.deleteWorktreeDocs(projectId, containerId);
    await indexer.deleteSourceFile(this.liveFilePath(projectId, containerId));
    await indexer.deleteSourceFile(
      this.worktreeArchiveFilePath(projectId, containerId),
    );
    await indexer.deleteSourceFile(this.plansFilePath(projectId, containerId));
    this.indexArchivedContainer(projectId, containerId);
  }

  async worktreeContainerRestored(
    projectId: string,
    containerId: string,
    destinationId: string,
  ): Promise<void> {
    try {
      await this.worktreeContainerPurged(projectId, containerId);
    } catch (error) {
      // Archived search rows are rebuildable. A closing or saturated worker
      // must not reject a completed restore or skip the destination refresh.
      // eslint-disable-next-line no-console
      console.error(
        '[chat-search] Failed to remove restored archive search rows',
        error,
      );
    }
    this.reactivateScope(projectId, destinationId);
    const generation = this.advanceWorktreeGeneration(projectId, destinationId);
    const archiveContentEpoch = this.advanceArchiveContentEpoch(
      projectId,
      destinationId,
    );
    try {
      const [tabs, archives] = await Promise.all([
        readChatTabsFileForIndex(projectId, destinationId),
        readChatArchivesFileForIndex(projectId, destinationId),
      ]);
      if (
        !this.isWorktreeGenerationCurrent(projectId, destinationId, generation)
      ) {
        return;
      }
      this.indexLiveTabs(projectId, destinationId, tabs);
      await this.replaceArchiveScope(
        projectId,
        destinationId,
        archives,
        archiveContentEpoch,
      );
      this.scheduleUpdatedBroadcast();
    } catch {
      // Search is disposable derived data; restore must still succeed when a
      // best-effort index refresh cannot read the restored chat files.
    }
  }

  async worktreeContainerPurged(
    projectId: string,
    containerId: string,
  ): Promise<void> {
    this.advanceWorktreeGeneration(projectId, containerId);
    this.deletedWorktrees.add(`${projectId}/${containerId}`);
    this.cancelPending(
      (key) => key === `archived-container:${projectId}/${containerId}`,
    );
    const indexer = this.getIndexer();
    await indexer.deleteArchivedContainerDocs(projectId, containerId);
    await indexer.deleteSourceFile(
      getArchivedContainerManifestPath(projectId, containerId),
    );
    this.scheduleUpdatedBroadcast();
  }

  archivedContainerUpdated(projectId: string, containerId: string): void {
    this.advanceWorktreeGeneration(projectId, containerId);
    this.cancelPending(
      (key) => key === `archived-container:${projectId}/${containerId}`,
    );
    this.indexArchivedContainer(projectId, containerId);
  }

  private async discardRemovedArchivedContainer(
    projectId: string,
    containerId: string,
    generation: number,
    error: unknown,
  ): Promise<boolean> {
    if (
      this.closed ||
      !this.isWorktreeGenerationCurrent(projectId, containerId, generation)
    )
      return true;
    const fileKey = getArchivedContainerManifestPath(projectId, containerId);
    if (
      !isErrnoException(error) ||
      error.code !== 'ENOENT' ||
      (await safeFingerprint(fileKey))
    )
      return false;
    // Removal can win the race before the lifecycle's search callback arrives.
    // Only a missing manifest retires this disposable scope, never a missing
    // transcript belonging to a still-present retained container.
    if (
      this.closed ||
      !this.isWorktreeGenerationCurrent(projectId, containerId, generation)
    )
      return true;
    const indexer = this.getIndexer();
    await indexer.deleteArchivedContainerDocs(projectId, containerId);
    await indexer.deleteSourceFile(fileKey);
    this.scheduleUpdatedBroadcast();
    return true;
  }

  indexArchivedContainer(projectId: string, containerId: string): void {
    const generation = this.worktreeGeneration(projectId, containerId);
    const fileKey = getArchivedContainerManifestPath(projectId, containerId);
    this.activeScanSourceKeys?.add(fileKey);
    this.enqueue(`archived-container:${projectId}/${containerId}`, async () => {
      if (
        this.closed ||
        !this.isWorktreeGenerationCurrent(projectId, containerId, generation)
      )
        return;
      const payload = await Promise.all([
        readArchivedContainerManifest(projectId, containerId),
        readArchivedSummaryForIndex(projectId, containerId),
        readArchivedContainerChats(projectId, containerId),
        readArchivedContainerChatArchives(projectId, containerId),
        readArchivedContainerTrackedPlans(projectId, containerId),
      ]).catch(async (error: unknown) => {
        if (
          await this.discardRemovedArchivedContainer(
            projectId,
            containerId,
            generation,
            error,
          )
        )
          return null;
        throw error;
      });
      if (payload === null) return;
      const [manifest, summary, chats, archives, plans] = payload;
      if (
        this.closed ||
        !this.isWorktreeGenerationCurrent(projectId, containerId, generation)
      ) {
        return;
      }
      await this.replaceContainerScope(
        manifest,
        summary,
        chats,
        archives,
        plans.plans,
        manifest.lockedAt ? undefined : manifest.expiresAt,
      );
      if (
        this.closed ||
        !this.isWorktreeGenerationCurrent(projectId, containerId, generation)
      ) {
        return;
      }
      await this.refreshFingerprint(
        fileKey,
        projectId,
        containerId,
        generation,
      );
    });
  }

  indexCoworkArchive(
    projectId: string,
    tab: PersistedChatTab,
    archivedAt: string,
  ): void {
    const workspaceId = resolveCoworkWorkspaceId(projectId);
    this.deletedCoworkArchives.delete(
      this.coworkArchiveKey(workspaceId, tab.id),
    );
    this.reactivateScope(workspaceId, COWORK_HOME_WORKTREE_ID);
    this.queueArchivedLiveChat(workspaceId, COWORK_HOME_WORKTREE_ID, tab.id);
    const archiveDirectory = this.coworkArchiveDir(workspaceId, tab.id);
    this.activeScanSourceKeys?.add(archiveDirectory);
    this.enqueue(`cowork-archive:${workspaceId}/${tab.id}`, async () => {
      if (this.isScopeDeleted(workspaceId, COWORK_HOME_WORKTREE_ID)) return;
      await this.getIndexer().upsertCoworkArchive(
        workspaceId,
        COWORK_HOME_WORKTREE_ID,
        tab,
        archivedAt,
      );
      const fingerprint = await coworkArchiveFingerprint(archiveDirectory);
      if (fingerprint && !this.closed) {
        await this.getIndexer().setSourceFingerprint(
          archiveDirectory,
          fingerprint,
        );
      }
    });
  }

  async deleteCoworkArchive(projectId: string, chatId: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const workspaceId = resolveCoworkWorkspaceId(projectId);
    const key = `cowork-archive:${workspaceId}/${chatId}`;
    const archiveDirectory = this.coworkArchiveDir(workspaceId, chatId);
    this.deletedCoworkArchives.add(this.coworkArchiveKey(workspaceId, chatId));
    this.activeScanSourceKeys?.delete(archiveDirectory);
    this.cancelPending((pendingKey) => pendingKey === key);
    await this.getIndexer().deleteChatDoc(
      workspaceId,
      COWORK_HOME_WORKTREE_ID,
      chatId,
      'cowork-archive',
    );
    await this.getIndexer().deleteSourceFile(archiveDirectory);
    this.scheduleUpdatedBroadcast();
    return Promise.resolve();
  }

  async deleteWorktreeDocs(
    projectId: string,
    worktreeId: string,
  ): Promise<void> {
    this.advanceWorktreeGeneration(projectId, worktreeId);
    this.deletedWorktrees.add(`${projectId}/${worktreeId}`);
    this.cancelPending(
      (key) =>
        key === this.liveUpdateKey(projectId, worktreeId) ||
        key === `archive:${projectId}/${worktreeId}` ||
        key === `plans:${projectId}/${worktreeId}` ||
        (worktreeId === COWORK_HOME_WORKTREE_ID &&
          key.startsWith(`cowork-archive:${projectId}/`)),
    );
    const indexer = this.getIndexer();
    await indexer.deleteWorktreeDocs(projectId, worktreeId);
    await indexer.deleteSourceFile(this.liveFilePath(projectId, worktreeId));
    await indexer.deleteSourceFile(
      this.worktreeArchiveFilePath(projectId, worktreeId),
    );
    await indexer.deleteSourceFile(this.plansFilePath(projectId, worktreeId));
    if (worktreeId === COWORK_HOME_WORKTREE_ID) {
      const historyRoot = `${getWorkspaceChatHistoryRootDir(projectId)}${sep}`;
      for (const fileKey of await indexer.listSourceFileKeys()) {
        if (fileKey.startsWith(historyRoot))
          await indexer.deleteSourceFile(fileKey);
      }
    }
    this.scheduleUpdatedBroadcast();
  }

  async deleteWorkspaceDocs(projectId: string): Promise<void> {
    for (const read of Array.from(this.childReads))
      if (read.projectId === projectId) read.controller.abort();
    this.deletedWorkspaces.add(projectId);
    for (const key of Array.from(this.syncedLiveScopes)) {
      if (key.startsWith(`live:${projectId}/`))
        this.syncedLiveScopes.delete(key);
    }
    this.cancelPending(
      (key) =>
        key.startsWith(`live:${projectId}/`) ||
        key.startsWith(`archive:${projectId}/`) ||
        key.startsWith(`plans:${projectId}/`) ||
        key.startsWith(`archived-container:${projectId}/`) ||
        key.startsWith(`cowork-archive:${projectId}/`),
    );
    const indexer = this.getIndexer();
    await indexer.deleteWorkspaceDocs(projectId);
    const workspaceRoot = `${getWorkspaceDir(projectId)}${sep}`;
    const appWorkspaceRoot = `${getAppManagedChatWorkspaceDir(projectId)}${sep}`;
    for (const fileKey of await indexer.listSourceFileKeys()) {
      if (
        fileKey.startsWith(workspaceRoot) ||
        fileKey.startsWith(appWorkspaceRoot)
      ) {
        await indexer.deleteSourceFile(fileKey);
      }
    }
    this.scheduleUpdatedBroadcast();
  }

  async flushPendingUpdates(): Promise<void> {
    const pending = Array.from(this.pendingUpdates.entries());
    this.pendingUpdates.clear();
    for (const [, update] of pending) clearTimeout(update.timer);
    let completedAny = false;
    // A failed batch retries every waiter in it, since reindexing is
    // idempotent; updates a closing service skipped have nothing to retry.
    let failure: { error: unknown } | undefined;
    try {
      try {
        for (const [key, update] of pending) {
          if (this.closed) return;
          // As in a debounced run, a newer live update takes this one over.
          if (update.liveTabsUpdate) this.runningLiveUpdates.set(key, update);
          try {
            await update.task();
          } catch (error) {
            if (!(error instanceof StaleSearchProjectionError)) throw error;
            continue;
          } finally {
            if (this.runningLiveUpdates.get(key) === update) {
              this.runningLiveUpdates.delete(key);
            }
          }
          completedAny = true;
        }
      } catch (error) {
        this.recoverFailedIndexer();
        throw error;
      } finally {
        // An explicit flush is one batch. Scheduling after the batch prevents
        // a slow later update from letting an earlier update's timer fire
        // midway.
        await this.flushIndexer();
        if (completedAny) this.scheduleUpdatedBroadcast();
      }
    } catch (error) {
      failure = { error };
      throw error;
    } finally {
      for (const [key, update] of pending) {
        this.settleRunningUpdate(key, update, failure);
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const read of Array.from(this.childReads)) read.controller.abort();
    if (this.indexerRecoveryTimer) {
      clearTimeout(this.indexerRecoveryTimer);
      this.indexerRecoveryTimer = null;
    }
    this.queryRunner?.close();
    this.queryRunner = null;
    this.cancelPending(() => true);
    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    if (this.indexer && 'close' in this.indexer) {
      this.db?.close();
      this.db = null;
      await this.indexer.close();
    }
    await Promise.allSettled(
      [this.activeScanPromise, this.initialScanPromise].filter(
        (value): value is Promise<void> => value !== null,
      ),
    );
    this.db?.close();
    this.db = null;
    this.indexer = null;
    this.workerDatabasePath = null;
  }

  private getDatabase(): DatabaseSync {
    if (this.closed) throw new Error('Chat search service is closed');
    if (this.db === null) {
      if (this.indexerFactory) {
        this.db = openChatSearchDatabase(this.dbPath);
        this.workerDatabasePath = getWorkerDatabasePath(this.db);
      } else {
        // Reads remain immediately available while the thread opens, repairs or
        // rebuilds the derived index. This tiny empty connection never receives bodies.
        this.db = openChatSearchDatabase(':memory:');
        const indexer = this.threadedIndexerFactory(this.dbPath);
        this.indexer = indexer;
        void indexer.ready
          .then((file): void => {
            if (this.closed) return;
            const reader = new DatabaseSync(file, { readOnly: true });
            reader.exec('PRAGMA busy_timeout = 0;');
            this.db?.close();
            this.db = reader;
            this.workerDatabasePath = file;
            this.scheduleUpdatedBroadcast();
          })
          .catch((error: unknown): void => {
            // eslint-disable-next-line no-console
            console.error('Search index reader could not open:', error);
          });
      }
    }
    return this.db;
  }

  /** Child admissions do not publish a primary transcript mutation. */
  childSearchDirty(event: ChildSearchDirtyNotification): void {
    const { projectId, worktreeId } = event.scope;
    if (this.closed || this.isScopeDeleted(projectId, worktreeId)) return;
    const generation = this.worktreeGeneration(projectId, worktreeId);
    const key = `child:${JSON.stringify([projectId, worktreeId, event.parentChatId])}`;
    // A pending reconcile reads the parent's current children when it runs,
    // so later changes join it instead of postponing it.
    if (this.pendingUpdates.has(key)) return;
    this.enqueue(
      key,
      async () => {
        const isCurrent = (): boolean =>
          !this.closed &&
          this.isWorktreeGenerationCurrent(projectId, worktreeId, generation);
        // A state read would readmit a scope deleted while this waited.
        if (!isCurrent()) return;
        const state = (
          await import('../services/chat-state-service')
        ).getChatStateService();
        const snapshot = await state.getCompatibilityTabs(event.scope);
        const tab = snapshot.tabs.find(
          (candidate) => candidate.id === event.parentChatId,
        );
        if (tab && isCurrent()) {
          await this.reconcileChildDocuments(
            buildChatSearchDoc(
              projectId,
              worktreeId,
              'live',
              tab,
              undefined,
              undefined,
              '',
            ),
            isCurrent,
          );
        } else if (isCurrent()) {
          const archives = await state.getCompatibilityArchives(event.scope);
          const entry = archives.archived.find(
            (candidate) => candidate.tab.id === event.parentChatId,
          );
          if (entry)
            await this.reconcileChildDocuments(
              buildChatSearchDoc(
                projectId,
                worktreeId,
                'worktree-archive',
                entry.tab,
                entry.archivedAt,
                undefined,
                '',
              ),
              isCurrent,
            );
        }
      },
      undefined,
      undefined,
      [],
      this.childSearchWindowMs,
    );
  }

  private async reconcileChildDocuments(
    parent: ChatSearchDoc,
    isCurrent: () => boolean,
    attempt = 0,
  ): Promise<void> {
    // Inline/legacy fixtures and sources have no canonical child registry.
    if (!parent.transcriptFingerprint) return;
    const assertCurrent = staleProjectionGuard(isCurrent);
    assertCurrent();
    const scope = {
      projectId: parent.projectId,
      worktreeId: parent.worktreeId,
    };
    const state = (
      await import('../services/chat-state-service')
    ).getChatStateService();
    let backend: ChatStateV2Backend | undefined;
    if (parent.source === 'archived-container') {
      backend = new ChatStateV2Backend(
        await getArchivedContainerChatStorage(
          parent.projectId,
          parent.worktreeId,
        ),
      );
    } else if (parent.source === 'cowork-archive') {
      const store = await getStandaloneHistoryStorage(
        parent.projectId,
        parent.chatId,
      );
      if (!store) throw new StaleSearchProjectionError();
      backend = new ChatStateV2Backend(store);
    }
    const read = { ...scope, controller: new AbortController() };
    this.childReads.add(read);
    const signal = read.controller.signal;
    const enumerate = (): Promise<ChildSearchDocumentIdentity[]> =>
      backend
        ? backend.listChildSearchDocuments(parent.chatId, signal)
        : state.listChildSearchDocuments(scope, parent.chatId, signal);
    const indexer = this.getIndexer();
    let stage: string | undefined;
    try {
      const identities = await enumerate();
      assertCurrent();
      stage = await indexer.beginChildDocumentStage(parent.docId);
      for (const identity of identities) {
        assertCurrent();
        const metadata = buildChatChildSearchDoc(
          parent,
          identity.target,
          identity.fingerprint,
          '',
        );
        if (
          await indexer.reuseChildDocument(
            stage,
            metadata.docId,
            identity.fingerprint,
          )
        )
          continue;
        const document = backend
          ? await backend.readChildSearchDocument(identity, signal)
          : await state.readChildSearchDocument(scope, identity, signal);
        assertCurrent();
        await indexer.stageChildDocument(
          stage,
          buildChatChildSearchDoc(
            parent,
            identity.target,
            document.fingerprint,
            document.body,
          ),
        );
      }
      assertCurrent();
      const latest = await enumerate();
      if (
        JSON.stringify(latest.map((identity) => identity.fingerprint)) !==
        JSON.stringify(identities.map((identity) => identity.fingerprint))
      )
        throw new StaleSearchProjectionError();
      assertCurrent();
      const staged = stage;
      const publish = async (): Promise<void> => {
        if (!(await indexer.commitChildDocumentStage(staged)))
          throw new StaleSearchProjectionError();
      };
      if (backend) await publish();
      else if (
        !(await state.commitChildSearchDocuments(
          scope,
          parent.chatId,
          identities,
          publish,
          isCurrent,
          signal,
        ))
      )
        throw new StaleSearchProjectionError();
      stage = undefined;
    } catch (error) {
      if (
        error instanceof StaleSearchProjectionError ||
        (error instanceof Error &&
          error.message === 'Child search source was superseded')
      ) {
        // Archive or deletion removes the parent without changing the
        // generation; its own reindex rebuilds children, so never chase it.
        if (
          isCurrent() &&
          attempt < CHILD_RECONCILE_RETRIES &&
          (await indexer.getIndexedCommittedFingerprint(parent.docId)) !== null
        )
          this.enqueue(`children-retry:${parent.docId}`, () =>
            this.reconcileChildDocuments(parent, isCurrent, attempt + 1),
          );
        return;
      }
      if (!isCurrent()) return;
      throw error;
    } finally {
      if (stage !== undefined) await indexer.discardChildDocumentStage(stage);
      this.childReads.delete(read);
    }
  }

  private async projectedChat(
    projectId: string,
    worktreeId: string,
    source: ChatSearchSource,
    tab: PersistedChatTab,
    archivedAt?: string,
    expiresAt?: string,
    isCurrent?: () => boolean,
  ): Promise<ChatSearchDoc> {
    const assertCurrent = staleProjectionGuard(isCurrent);
    assertCurrent();
    if (!tab.transcript)
      return buildChatSearchDoc(
        projectId,
        worktreeId,
        source,
        tab,
        archivedAt,
        expiresAt,
      );
    // A scope replacement re-projects every chat in the scope. Carry forward
    // bodies whose transcript is already indexed instead of re-reading each
    // JSONL and artifact under the scope lease.
    const indexed =
      this.closed || !tab.transcript.committedDigest
        ? null
        : await this.getIndexer().getIndexedBodiesIfTranscriptUnchanged(
            `${projectId}/${worktreeId}/${tab.id}/${source}`,
            transcriptFingerprint(tab.transcript),
          );
    assertCurrent();
    if (indexed !== null)
      return withTranscriptSplit(
        buildChatSearchDoc(
          projectId,
          worktreeId,
          source,
          tab,
          archivedAt,
          expiresAt,
          indexed.body,
        ),
        indexed.activeBody,
        indexed.committedFingerprint,
      );
    const consume = async (
      rows: AsyncIterable<PersistedChatMessage>,
    ): Promise<string> => {
      const text: string[] = [];
      for await (const message of rows) {
        assertCurrent();
        const body = extractChatSearchBody([message]);
        if (body) text.push(body);
      }
      return text.join('\n\n');
    };
    let body: string;
    if (source === 'archived-container') {
      const store = await getArchivedContainerChatStorage(
        projectId,
        worktreeId,
      );
      body = await new ChatStateV2Backend(store).consumeTranscript(
        tab.id,
        false,
        consume,
      );
    } else if (source === 'cowork-archive') {
      const store = await getStandaloneHistoryStorage(projectId, tab.id);
      if (!store) throw new Error('Archive disappeared while indexing');
      body = await new ChatStateV2Backend(store).consumeTranscript(
        tab.id,
        false,
        consume,
      );
    } else {
      const projection = await this.projectTranscriptPreview(
        projectId,
        worktreeId,
        tab,
        assertCurrent,
        isCurrent,
      );
      assertCurrent();
      if (source === 'live')
        this.rememberActiveTurnText(projectId, worktreeId, tab.id, projection);
      return buildPreviewSearchDoc(
        projectId,
        worktreeId,
        source,
        tab,
        projection,
        archivedAt,
        expiresAt,
      );
    }
    assertCurrent();
    return buildChatSearchDoc(
      projectId,
      worktreeId,
      source,
      tab,
      archivedAt,
      expiresAt,
      body,
    );
  }

  /**
   * Projects a live or worktree-archive transcript through a captured
   * preview, keeping committed and in-flight text apart. With
   * `reuseCommitted`, a descriptor whose committed prefix has that identity
   * streams only the active sidecar rows.
   */
  private async projectTranscriptPreview(
    projectId: string,
    worktreeId: string,
    tab: PersistedChatTab,
    assertCurrent: () => void,
    isCurrent?: () => boolean,
    reuseCommitted?: string,
  ): Promise<TranscriptPreviewProjection> {
    // Defer the heavy state service to the live V2 transcript branch.
    const { getChatStateService } =
      await import('../services/chat-state-service');
    try {
      return await getChatStateService().consumeTranscriptPreview(
        { projectId, worktreeId },
        tab.id,
        async (messages, descriptor, read) => {
          const committedText: string[] = [];
          const activeText: string[] = [];
          const activeRows: Array<{ id: string; text: string }> = [];
          // An active-only read starts after the committed prefix.
          let position = read.committedIncluded
            ? 0
            : descriptor.committedMessageCount;
          for await (const message of messages) {
            assertCurrent();
            const text = extractChatSearchBody([message]);
            const committed = position < descriptor.committedMessageCount;
            if (!committed) activeRows.push({ id: message.id, text });
            if (text) (committed ? committedText : activeText).push(text);
            position += 1;
          }
          return {
            descriptor,
            committedBody: read.committedIncluded
              ? committedText.join('\n\n')
              : undefined,
            activeBody: activeText.join('\n\n'),
            activeRows,
            ...(read.journalProjected ? { journalProjected: true } : {}),
          };
        },
        isCurrent,
        reuseCommitted === undefined
          ? {}
          : {
              reuseCommittedPrefix: (descriptor): boolean =>
                committedTranscriptFingerprint(descriptor) === reuseCommitted,
            },
      );
    } catch (error) {
      // Deletion can close a captured handle before the next row check.
      // Only a stale generation converts that cancellation into a no-op.
      staleProjectionGuard(isCurrent)();
      throw error;
    }
  }

  /**
   * An active-sidecar revision leaves a live transcript's committed prefix
   * unchanged. When the index holds that prefix, read only the sidecar and
   * replace only the chat's in-flight row. False means nothing was written
   * and the whole transcript must be projected.
   */
  private async replaceLiveActiveText(
    projectId: string,
    worktreeId: string,
    tab: PersistedChatTab,
    isCurrent: () => boolean,
  ): Promise<boolean> {
    const transcript = tab.transcript;
    if (!transcript?.committedDigest || !isCurrent()) return false;
    const indexer = this.getIndexer();
    const indexedCommitted = await indexer.getIndexedCommittedFingerprint(
      `${projectId}/${worktreeId}/${tab.id}/live`,
    );
    if (
      indexedCommitted !== committedTranscriptFingerprint(transcript) ||
      !isCurrent()
    )
      return false;
    const fromJournal = await this.replaceLiveActiveTextFromJournal(
      projectId,
      worktreeId,
      tab,
      indexedCommitted,
      isCurrent,
    );
    if (fromJournal !== undefined) return fromJournal;
    let projection: TranscriptPreviewProjection;
    try {
      projection = await this.projectTranscriptPreview(
        projectId,
        worktreeId,
        tab,
        staleProjectionGuard(isCurrent),
        isCurrent,
        indexedCommitted,
      );
    } catch (error) {
      // An active-only read never checks the committed bytes, so it refuses
      // a committed log that changed after capture. Project the whole
      // transcript instead; a persistent integrity failure surfaces there.
      if (error instanceof ChatTranscriptIntegrityError) return false;
      throw error;
    }
    // A superseded projection is dropped; the newer update indexes the chat.
    if (!isCurrent()) return true;
    this.rememberActiveTurnText(projectId, worktreeId, tab.id, projection);
    const doc = buildPreviewSearchDoc(
      projectId,
      worktreeId,
      'live',
      tab,
      projection,
    );
    if (projection.committedBody === undefined)
      return indexer.replaceActiveBodyIfCommittedUnchanged(doc);
    // The prefix changed after the lookup, so the preview read all of it.
    await indexer.upsertDoc(doc);
    return true;
  }

  /**
   * Cache a journal-projected read's in-flight rows, so the chat's next
   * updates re-extract only the rows its turn changed.
   */
  private rememberActiveTurnText(
    projectId: string,
    worktreeId: string,
    chatId: string,
    projection: TranscriptPreviewProjection,
  ): void {
    const key = `${projectId}/${worktreeId}/${chatId}/live`;
    if (!projection.journalProjected || !projection.activeRows) {
      this.activeTurnText.delete(key);
      return;
    }
    this.activeTurnText.reset(
      key,
      {
        committedFingerprint: committedTranscriptFingerprint(
          projection.descriptor,
        ),
        transcriptRevision: projection.descriptor.transcriptRevision,
      },
      projection.activeRows,
    );
  }

  /**
   * A delta-journal chat's in-flight text from the rows its turn changed
   * since the cached revision, read from the journal writer's memory: no
   * preview capture, no journal replay. Undefined when no cached state or
   * delta applies; the caller then reads the active rows whole.
   */
  private async replaceLiveActiveTextFromJournal(
    projectId: string,
    worktreeId: string,
    tab: PersistedChatTab,
    indexedCommitted: string,
    isCurrent: () => boolean,
  ): Promise<boolean | undefined> {
    const key = `${projectId}/${worktreeId}/${tab.id}/live`;
    const cached = this.activeTurnText.state(key);
    if (!cached || cached.committedFingerprint !== indexedCommitted)
      return undefined;
    let answer:
      | {
          descriptor: TranscriptPreviewProjection['descriptor'];
          delta: ActiveTurnDelta;
        }
      | undefined;
    try {
      // The same deferred import as projectTranscriptPreview's.
      const { getChatStateService } =
        await import('../services/chat-state-service');
      answer = await getChatStateService().activeTurnDelta(
        { projectId, worktreeId },
        tab.id,
        cached.transcriptRevision,
      );
    } catch {
      answer = undefined;
    }
    if (!isCurrent()) return true;
    const body =
      answer &&
      committedTranscriptFingerprint(answer.descriptor) === indexedCommitted
        ? this.activeTurnText.apply(
            key,
            indexedCommitted,
            cached.transcriptRevision,
            answer.delta,
          )
        : undefined;
    if (!answer || body === undefined) {
      this.activeTurnText.delete(key);
      return undefined;
    }
    return this.getIndexer().replaceActiveBodyIfCommittedUnchanged(
      buildPreviewSearchDoc(projectId, worktreeId, 'live', tab, {
        descriptor: answer.descriptor,
        committedBody: undefined,
        activeBody: body,
      }),
    );
  }

  private async upsertLiveChat(
    projectId: string,
    worktreeId: string,
    tab: PersistedChatTab,
    contentEpoch: number,
  ): Promise<void> {
    if ((tab.kind ?? 'chat') !== 'chat') return;
    const generation = this.worktreeGeneration(projectId, worktreeId);
    const isCurrent = (): boolean =>
      !this.closed &&
      this.isWorktreeGenerationCurrent(projectId, worktreeId, generation) &&
      this.isLiveContentEpochCurrent(projectId, worktreeId, contentEpoch);
    if (
      !!tab.transcript?.committedDigest &&
      isCurrent() &&
      (await this.getIndexer().updateDocMetadataIfTranscriptUnchanged(
        buildChatSearchDoc(
          projectId,
          worktreeId,
          'live',
          tab,
          undefined,
          undefined,
          '',
        ),
      ))
    ) {
      await this.reconcileChildDocuments(
        buildChatSearchDoc(
          projectId,
          worktreeId,
          'live',
          tab,
          undefined,
          undefined,
          '',
        ),
        isCurrent,
      );
      return;
    }
    if (
      await this.replaceLiveActiveText(projectId, worktreeId, tab, isCurrent)
    ) {
      await this.reconcileChildDocuments(
        buildChatSearchDoc(
          projectId,
          worktreeId,
          'live',
          tab,
          undefined,
          undefined,
          '',
        ),
        isCurrent,
      );
      return;
    }
    const parent = await this.upsertProjectedLiveChat(
      projectId,
      worktreeId,
      tab,
      isCurrent,
    );
    if (parent) await this.reconcileChildDocuments(parent, isCurrent);
  }

  /**
   * Indexes a live chat's projected text and returns its document without
   * that text. Child reconciliation needs only the identity, and a long
   * chat's body would otherwise stay alive across every child read.
   */
  private async upsertProjectedLiveChat(
    projectId: string,
    worktreeId: string,
    tab: PersistedChatTab,
    isCurrent: () => boolean,
  ): Promise<ChatSearchDoc | null> {
    const doc = await this.projectedChat(
      projectId,
      worktreeId,
      'live',
      tab,
      undefined,
      undefined,
      isCurrent,
    );
    if (!isCurrent()) return null;
    await this.getIndexer().upsertDoc(doc);
    return { ...doc, body: '', activeBody: undefined };
  }

  private async replaceLiveScope(
    projectId: string,
    worktreeId: string,
    data: ChatTabsFile,
    contentEpoch: number,
  ): Promise<void> {
    // A whole-scope projection re-reads or reuses every chat; cached
    // in-flight rows are seeded again by its journal-projected reads.
    this.activeTurnText.deletePrefix(`${projectId}/${worktreeId}/`);
    const projectChat = this.projectedChat.bind(this);
    const generation = this.worktreeGeneration(projectId, worktreeId);
    const isCurrent = (): boolean =>
      !this.closed &&
      this.isWorktreeGenerationCurrent(projectId, worktreeId, generation) &&
      this.isLiveContentEpochCurrent(projectId, worktreeId, contentEpoch);
    await this.getIndexer().replaceStreamedScope(
      projectId,
      worktreeId,
      'live',
      (async function* (): AsyncGenerator<ChatSearchDoc> {
        for (const tab of data.tabs)
          if ((tab.kind ?? 'chat') === 'chat')
            yield await projectChat(
              projectId,
              worktreeId,
              'live',
              tab,
              undefined,
              undefined,
              isCurrent,
            );
      })(),
      isCurrent,
    );
    for (const tab of data.tabs)
      if ((tab.kind ?? 'chat') === 'chat')
        await this.reconcileChildDocuments(
          buildChatSearchDoc(
            projectId,
            worktreeId,
            'live',
            tab,
            undefined,
            undefined,
            '',
          ),
          isCurrent,
        );
  }

  private async replaceArchiveScope(
    projectId: string,
    worktreeId: string,
    data: ArchivedChatsFile,
    contentEpoch: number,
  ): Promise<void> {
    const projectChat = this.projectedChat.bind(this);
    const generation = this.worktreeGeneration(projectId, worktreeId);
    const isCurrent = (): boolean =>
      !this.closed &&
      this.isWorktreeGenerationCurrent(projectId, worktreeId, generation) &&
      this.isArchiveContentEpochCurrent(projectId, worktreeId, contentEpoch);
    await this.getIndexer().replaceStreamedScope(
      projectId,
      worktreeId,
      'worktree-archive',
      (async function* (): AsyncGenerator<ChatSearchDoc> {
        for (const entry of data.archived)
          yield await projectChat(
            projectId,
            worktreeId,
            'worktree-archive',
            entry.tab,
            entry.archivedAt,
          );
      })(),
      isCurrent,
    );
    for (const entry of data.archived)
      await this.reconcileChildDocuments(
        buildChatSearchDoc(
          projectId,
          worktreeId,
          'worktree-archive',
          entry.tab,
          entry.archivedAt,
          undefined,
          '',
        ),
        isCurrent,
      );
  }

  private async replaceContainerScope(
    manifest: ArchivedContainerManifest,
    summary: WorktreeSummaryData | null,
    chats: ChatTabsFile,
    archives: ArchivedChatsFile,
    plans: readonly TrackedPlanIndexEntry[],
    expiresAt?: string,
  ): Promise<void> {
    const projectChat = this.projectedChat.bind(this);
    const { projectId, id: worktreeId } = manifest;
    const generation = this.worktreeGeneration(projectId, worktreeId);
    const entries = new Map(
      archives.archived.map((entry) => [entry.tab.id, entry]),
    );
    for (const tab of chats.tabs)
      if ((tab.kind ?? 'chat') === 'chat')
        entries.set(tab.id, {
          tab,
          archivedAt: manifest.archivedAt,
          turnCount: 0,
        });
    const count = Array.from(entries.values()).reduce(
      (total, entry) =>
        total +
        (entry.tab.transcript?.messageCount ??
          entry.tab.transcript?.committedMessageCount ??
          entry.tab.messages.length),
      0,
    );
    await this.getIndexer().replaceStreamedScope(
      projectId,
      worktreeId,
      'archived-container',
      (async function* (): AsyncGenerator<ChatSearchDoc> {
        yield buildArchivedContainerEntityDoc(
          manifest,
          summary,
          count,
          expiresAt,
        );
        for (const entry of Array.from(entries.values()))
          yield await projectChat(
            projectId,
            worktreeId,
            'archived-container',
            entry.tab,
            entry.archivedAt,
            expiresAt,
          );
        if (manifest.kind === 'worktree')
          for (const plan of plans)
            if (!plan.hidden)
              yield buildPlanSearchDoc(projectId, worktreeId, plan, {
                source: 'archived-container',
                archivedAt: manifest.archivedAt,
                expiresAt,
              });
      })(),
      () =>
        !this.closed &&
        this.isWorktreeGenerationCurrent(projectId, worktreeId, generation),
    );
    for (const entry of Array.from(entries.values()))
      await this.reconcileChildDocuments(
        buildChatSearchDoc(
          projectId,
          worktreeId,
          'archived-container',
          entry.tab,
          entry.archivedAt,
          expiresAt,
          '',
        ),
        (): boolean =>
          !this.closed &&
          this.isWorktreeGenerationCurrent(projectId, worktreeId, generation),
      );
  }

  private getIndexer(): ChatSearchIndexer | ThreadedChatSearchIndexer {
    if (!this.indexer) {
      const database = this.getDatabase();
      this.indexer ??= this.indexerFactory
        ? this.indexerFactory(database)
        : this.threadedIndexerFactory(this.dbPath);
    }
    return this.indexer;
  }

  /**
   * A failed index worker rejects every later request, so without replacement
   * search would stay stale until restart. Replace it after a backoff and
   * rescan; source fingerprints limit the rescan to what changed.
   */
  private recoverFailedIndexer(): void {
    const failed = this.indexer;
    if (
      this.closed ||
      this.indexerRecoveryTimer !== null ||
      failed === null ||
      !('isFailed' in failed) ||
      !failed.isFailed()
    ) {
      return;
    }
    const delayMs = Math.min(
      CHAT_SEARCH_INDEXER_RECOVERY_DELAY_MS * 2 ** this.indexerRecoveryAttempts,
      CHAT_SEARCH_INDEXER_RECOVERY_MAX_DELAY_MS,
    );
    this.indexerRecoveryAttempts += 1;
    this.indexerRecoveryTimer = setTimeout(() => {
      this.indexerRecoveryTimer = null;
      if (this.closed || this.indexer !== failed) return;
      this.indexer = null;
      // The replacement may have rebuilt the index without these scopes.
      this.syncedLiveScopes.clear();
      this.db?.close();
      this.db = null;
      this.workerDatabasePath = null;
      void failed.close().catch(() => undefined);
      void this.scanAllSources().then(
        () => {
          this.indexerRecoveryAttempts = 0;
        },
        (error: unknown) => {
          // eslint-disable-next-line no-console
          console.error('Chat search recovery scan failed:', error);
          this.recoverFailedIndexer();
        },
      );
    }, delayMs);
    this.indexerRecoveryTimer.unref?.();
  }

  private async flushIndexer(): Promise<void> {
    if (this.indexer && 'flush' in this.indexer) await this.indexer.flush();
  }

  private isVisibleEntry(entry: ChatSearchCatalogEntry): boolean {
    return (
      !this.isScopeDeleted(entry.projectId, entry.worktreeId) &&
      (entry.source !== 'cowork-archive' ||
        !this.isCoworkArchiveDeleted(entry.projectId, entry.chatId)) &&
      !(
        entry.source !== 'archived-container' &&
        this.hiddenLiveScopes.has(`${entry.projectId}/${entry.worktreeId}`)
      )
    );
  }

  private createContextVisibilityPredicate(
    context: WorkspaceContext,
    linkedPersonalWorkspaceIds: readonly string[] = [],
  ): (entry: ChatSearchCatalogEntry) => Promise<boolean> {
    const linkedPersonalIds = new Set(linkedPersonalWorkspaceIds);
    const owners = new Map<
      string,
      Promise<SearchWorkspaceOwner | undefined | null>
    >();
    return async (entry): Promise<boolean> => {
      if (!this.isVisibleEntry(entry)) return false;
      if (entry.projectId === APP_ADVISOR_PROJECT_ID) return true;
      let owner = owners.get(entry.projectId);
      if (!owner) {
        owner = this.resolveWorkspaceOwner(entry.projectId);
        owners.set(entry.projectId, owner);
      }
      const resolved = await owner;
      // A stale index row must not reveal a title after its ownership metadata
      // disappears. Unscoped callers still retain the legacy catalog above.
      if (resolved === null) return false;
      if (
        context.kind === 'organization' &&
        resolved === undefined &&
        linkedPersonalIds.has(entry.projectId)
      ) {
        return true;
      }
      return workspaceOwnerMatchesContext(resolved, context);
    };
  }

  private collectVisiblePage<T extends ChatSearchCatalogEntry>(
    limit: number,
    fetchPage: (offset: number) => T[],
  ): T[] {
    const visible: T[] = [];
    let offset = 0;
    while (visible.length < limit) {
      const page = fetchPage(offset);
      if (page.length === 0) break;
      offset += page.length;
      visible.push(...page.filter((entry) => this.isVisibleEntry(entry)));
      if (page.length < limit) break;
    }
    return visible.slice(0, limit);
  }

  private async collectVisiblePageAsync<T extends ChatSearchCatalogEntry>(
    limit: number,
    fetchPage: (offset: number) => Promise<T[]>,
    isVisible?: (entry: T) => boolean | Promise<boolean>,
  ): Promise<T[]> {
    // Not a parameter default: the bytecode main build's arrow transform
    // leaves `this` unbound in one (main-bytecode-arrow-defaults.test.ts).
    const isEntryVisible =
      isVisible ?? ((entry: T): boolean => this.isVisibleEntry(entry));
    const visible: T[] = [];
    let offset = 0;
    while (visible.length < limit) {
      const page = await fetchPage(offset);
      if (page.length === 0) break;
      offset += page.length;
      const pageVisibility = await Promise.all(
        page.map((entry) => Promise.resolve(isEntryVisible(entry))),
      );
      visible.push(
        ...page.filter((_entry, index) => pageVisibility[index] === true),
      );
      if (page.length < limit) break;
    }
    return visible.slice(0, limit);
  }

  private enqueue(
    key: string,
    task: () => Promise<void> | void,
    liveTabsUpdate?: PendingLiveTabsUpdate,
    waiter?: PendingUpdateWaiter,
    inheritedWaiters: readonly PendingUpdateWaiter[] = [],
    delayMs = this.debounceMs,
  ): void {
    if (this.closed) {
      settleWaiters(inheritedWaiters);
      waiter?.();
      return;
    }
    const existing = this.pendingUpdates.get(key);
    if (existing) clearTimeout(existing.timer);
    const waiters = existing?.waiters ?? [];
    waiters.push(...inheritedWaiters);
    if (waiter) waiters.push(waiter);
    const timer = setTimeout(() => {
      const pending = this.pendingUpdates.get(key);
      if (!pending || pending.timer !== timer) return;
      this.pendingUpdates.delete(key);
      if (pending.liveTabsUpdate) this.runningLiveUpdates.set(key, pending);
      void this.runIncrementalTask(pending.task).then(
        () => this.settleRunningUpdate(key, pending),
        (error: unknown) => {
          if (error instanceof StaleSearchProjectionError) {
            this.settleRunningUpdate(key, pending);
            return;
          }
          // The index is disposable derived data; persistence must not fail
          // when an incremental refresh cannot complete. Waiters retry.
          // eslint-disable-next-line no-console
          console.error('Chat search incremental update failed:', error);
          this.settleRunningUpdate(key, pending, { error });
        },
      );
    }, delayMs);
    timer.unref?.();
    this.pendingUpdates.set(key, { timer, task, liveTabsUpdate, waiters });
  }

  /** Settles the waiters a newer update has not taken over. */
  private settleRunningUpdate(
    key: string,
    update: PendingUpdate,
    failure?: { error: unknown },
  ): void {
    if (this.runningLiveUpdates.get(key) === update) {
      this.runningLiveUpdates.delete(key);
    }
    settleWaiters(update.waiters.splice(0), failure);
  }

  private cancelPending(predicate: (key: string) => boolean): void {
    for (const [key, update] of Array.from(this.pendingUpdates.entries())) {
      if (!predicate(key)) continue;
      clearTimeout(update.timer);
      this.pendingUpdates.delete(key);
      // Its scope was removed or replaced, so there is nothing to retry.
      settleWaiters(update.waiters);
    }
    // A workspace deletion keeps the generation, so a reactivated scope could
    // otherwise take over its old incarnation's running update. The running
    // task still settles its own waiters once it stops.
    for (const key of Array.from(this.runningLiveUpdates.keys())) {
      if (predicate(key)) this.runningLiveUpdates.delete(key);
    }
  }

  private async performFullScan(): Promise<void> {
    const sourceKeys = new Set<string>();
    this.activeScanSourceKeys = sourceKeys;
    try {
      const descriptors = await this.enumerateSources();
      if (this.closed) return;
      for (const descriptor of descriptors) {
        sourceKeys.add(descriptor.fileKey);
      }
      const liveFingerprintsFenced =
        (await this.getIndexer().getMetadata(
          LIVE_FINGERPRINT_FENCE_METADATA_KEY,
        )) === '1';
      for (const descriptor of descriptors) {
        if (this.closed) return;
        if (descriptor.kind === 'live' && !liveFingerprintsFenced) {
          // Dropped first, so a reindex this scan skips or cannot finish
          // leaves the next scan nothing to trust.
          await this.getIndexer().deleteSourceFile(descriptor.fileKey);
        }
        if (this.isScopeDeleted(descriptor.projectId, descriptor.worktreeId)) {
          continue;
        }
        const previous = await this.getIndexer().getSourceFingerprint(
          descriptor.fileKey,
        );
        if (
          previous?.mtimeMs === descriptor.fingerprint.mtimeMs &&
          previous.sizeBytes === descriptor.fingerprint.sizeBytes &&
          // A live update since enumeration may have indexed only its chats.
          (descriptor.kind !== 'live' ||
            this.syncedLiveScopes.has(
              this.liveUpdateKey(descriptor.projectId, descriptor.worktreeId),
            ) ||
            this.isLiveContentEpochCurrent(
              descriptor.projectId,
              descriptor.worktreeId,
              descriptor.liveContentEpoch ?? 0,
            ))
        ) {
          if (
            descriptor.kind === 'live' &&
            this.isWorktreeGenerationCurrent(
              descriptor.projectId,
              descriptor.worktreeId,
              descriptor.worktreeGeneration,
            )
          ) {
            this.syncedLiveScopes.add(
              this.liveUpdateKey(descriptor.projectId, descriptor.worktreeId),
            );
          }
          await yieldToMainLoop();
          continue;
        }
        await this.indexSource(descriptor);
        await yieldToMainLoop();
      }
      if (this.closed) return;
      await this.pruneMissingSources(sourceKeys);
      if (!liveFingerprintsFenced) {
        await this.getIndexer().setMetadata(
          LIVE_FINGERPRINT_FENCE_METADATA_KEY,
          '1',
        );
      }
      await this.getIndexer().setMetadata(
        'last_full_scan_at',
        String(Date.now()),
      );
      this.scheduleUpdatedBroadcast();
    } finally {
      if (this.activeScanSourceKeys === sourceKeys) {
        this.activeScanSourceKeys = null;
      }
    }
  }

  private async enumerateSources(): Promise<SourceDescriptor[]> {
    const descriptors: SourceDescriptor[] = [];
    const workspacesRoot = getWorkspacesRootDir();
    const workspaceEntries = await safeReadDir(workspacesRoot);
    for (const workspaceEntry of workspaceEntries) {
      if (!workspaceEntry.isDirectory()) continue;
      const projectId = workspaceEntry.name;
      await this.enumerateFlatJsonSources(
        descriptors,
        dirname(getWorkspaceChatTabsFilePath(projectId, 'placeholder')),
        'live',
        projectId,
      );
      await this.enumerateFlatJsonSources(
        descriptors,
        dirname(getWorkspaceChatArchivesFilePath(projectId, 'placeholder')),
        'worktree-archive',
        projectId,
      );
      await this.enumerateFlatJsonSources(
        descriptors,
        dirname(getWorkspaceTrackedPlansFilePath(projectId, 'placeholder')),
        'plan',
        projectId,
      );
      const archiveEntries = await safeReadDir(
        getWorkspaceChatHistoryRootDir(projectId),
      );
      for (const archiveEntry of archiveEntries) {
        if (!archiveEntry.isDirectory()) continue;
        const fileKey = getWorkspaceChatHistoryDir(
          projectId,
          archiveEntry.name,
        );
        const worktreeGeneration = this.worktreeGeneration(
          projectId,
          COWORK_HOME_WORKTREE_ID,
        );
        const fingerprint = await coworkArchiveFingerprint(fileKey);
        if (!fingerprint) continue;
        descriptors.push({
          fileKey,
          kind: 'cowork-archive',
          projectId,
          worktreeId: COWORK_HOME_WORKTREE_ID,
          worktreeGeneration,
          chatId: archiveEntry.name,
          fingerprint,
        });
      }
      await this.enumerateArchivedContainers(descriptors, projectId);
    }

    await this.enumerateFlatJsonSources(
      descriptors,
      dirname(
        getWorkspaceChatTabsFilePath(APP_ADVISOR_PROJECT_ID, 'placeholder'),
      ),
      'live',
      APP_ADVISOR_PROJECT_ID,
    );
    await this.enumerateFlatJsonSources(
      descriptors,
      dirname(
        getWorkspaceChatArchivesFilePath(APP_ADVISOR_PROJECT_ID, 'placeholder'),
      ),
      'worktree-archive',
      APP_ADVISOR_PROJECT_ID,
    );
    await this.enumerateArchivedContainers(descriptors, APP_ADVISOR_PROJECT_ID);
    return descriptors;
  }

  private async enumerateArchivedContainers(
    descriptors: SourceDescriptor[],
    projectId: string,
  ): Promise<void> {
    try {
      validateId(projectId, 'projectId');
    } catch {
      return;
    }
    for (const entry of await safeReadDir(
      getArchivedContainersRootDir(projectId),
    )) {
      if (!entry.isDirectory()) continue;
      try {
        validateId(entry.name, 'containerId');
      } catch {
        continue;
      }
      const fileKey = getArchivedContainerManifestPath(projectId, entry.name);
      const worktreeGeneration = this.worktreeGeneration(projectId, entry.name);
      const fingerprint = await safeFingerprint(fileKey);
      if (!fingerprint) continue;
      descriptors.push({
        fileKey,
        kind: 'archived-container',
        projectId,
        worktreeId: entry.name,
        worktreeGeneration,
        fingerprint,
      });
    }
  }

  private async enumerateFlatJsonSources(
    descriptors: SourceDescriptor[],
    directory: string,
    kind: 'live' | 'worktree-archive' | 'plan',
    projectId: string,
  ): Promise<void> {
    const entries = await safeReadDir(directory);
    const ids = new Set(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => basename(entry.name, '.json')),
    );
    if (kind !== 'plan') {
      for (const entry of await safeReadDir(
        join(dirname(directory), 'chat-storage-manifests'),
      )) {
        if (
          entry.isFile() &&
          entry.name.endsWith('.json') &&
          !entry.name.startsWith('plan-explore-chats-')
        )
          ids.add(basename(entry.name, '.json'));
      }
    }
    for (const worktreeId of Array.from(ids)) {
      const fileKey = join(directory, `${worktreeId}.json`);
      const worktreeGeneration = this.worktreeGeneration(projectId, worktreeId);
      const archiveContentEpoch =
        kind === 'worktree-archive'
          ? this.archiveContentEpoch(projectId, worktreeId)
          : undefined;
      const liveContentEpoch =
        kind === 'live'
          ? this.liveContentEpoch(projectId, worktreeId)
          : undefined;
      const fingerprint = await this.sourceFingerprint(
        fileKey,
        projectId,
        worktreeId,
      );
      if (!fingerprint) continue;
      descriptors.push({
        fileKey,
        kind,
        projectId,
        worktreeId,
        worktreeGeneration,
        ...(archiveContentEpoch !== undefined ? { archiveContentEpoch } : {}),
        ...(liveContentEpoch !== undefined ? { liveContentEpoch } : {}),
        fingerprint,
      });
    }
  }

  private async indexSource(descriptor: SourceDescriptor): Promise<void> {
    try {
      await this.indexCurrentSource(descriptor);
    } catch (error) {
      // An explicit deletion or a newer live projection can supersede this
      // source while its transcript is being read. Continue the full scan.
      if (
        error instanceof StaleSearchProjectionError ||
        this.closed ||
        !this.isWorktreeGenerationCurrent(
          descriptor.projectId,
          descriptor.worktreeId,
          descriptor.worktreeGeneration,
        ) ||
        this.isCoworkArchiveDeleted(descriptor.projectId, descriptor.chatId)
      )
        return;
      throw error;
    }
  }

  private async indexCurrentSource(
    descriptor: SourceDescriptor,
  ): Promise<void> {
    const indexer = this.getIndexer();
    const generation = descriptor.worktreeGeneration;
    if (descriptor.kind === 'live') {
      if (!(await this.indexScannedLiveSource(descriptor))) return;
    } else if (descriptor.kind === 'worktree-archive') {
      const contentEpoch =
        descriptor.archiveContentEpoch ??
        this.archiveContentEpoch(descriptor.projectId, descriptor.worktreeId);
      const data = await readChatArchivesFileForIndex(
        descriptor.projectId,
        descriptor.worktreeId,
      );
      if (
        this.closed ||
        !this.isWorktreeGenerationCurrent(
          descriptor.projectId,
          descriptor.worktreeId,
          generation,
        ) ||
        !this.isArchiveContentEpochCurrent(
          descriptor.projectId,
          descriptor.worktreeId,
          contentEpoch,
        )
      ) {
        return;
      }
      await this.replaceArchiveScope(
        descriptor.projectId,
        descriptor.worktreeId,
        data,
        contentEpoch,
      );
    } else if (descriptor.kind === 'plan') {
      const entries = await readTrackedPlansForIndex(descriptor.fileKey);
      if (
        this.closed ||
        !this.isWorktreeGenerationCurrent(
          descriptor.projectId,
          descriptor.worktreeId,
          generation,
        )
      ) {
        return;
      }
      await indexer.replaceWorktreePlans(
        descriptor.projectId,
        descriptor.worktreeId,
        entries,
      );
    } else if (descriptor.kind === 'archived-container') {
      const manifest = await readArchivedContainerManifest(
        descriptor.projectId,
        descriptor.worktreeId,
      ).catch(async (error: unknown) => {
        if (
          await this.discardRemovedArchivedContainer(
            descriptor.projectId,
            descriptor.worktreeId,
            generation,
            error,
          )
        )
          return null;
        throw error;
      });
      if (manifest === null) return;
      if (
        this.closed ||
        !this.isWorktreeGenerationCurrent(
          descriptor.projectId,
          descriptor.worktreeId,
          generation,
        )
      ) {
        return;
      }
      if (manifest.restoredTo) {
        await indexer.deleteArchivedContainerDocs(
          descriptor.projectId,
          descriptor.worktreeId,
        );
      } else {
        const [summary, chats, archives, plans] = await Promise.all([
          readArchivedSummaryForIndex(
            descriptor.projectId,
            descriptor.worktreeId,
          ),
          readArchivedContainerChats(
            descriptor.projectId,
            descriptor.worktreeId,
          ),
          readArchivedContainerChatArchives(
            descriptor.projectId,
            descriptor.worktreeId,
          ),
          readArchivedContainerTrackedPlans(
            descriptor.projectId,
            descriptor.worktreeId,
          ),
        ]);
        await this.replaceContainerScope(
          manifest,
          summary,
          chats,
          archives,
          plans.plans,
          manifest.lockedAt ? undefined : manifest.expiresAt,
        );
      }
    } else if (descriptor.chatId) {
      await this.indexCoworkArchiveSource(descriptor, generation);
    }
    if (
      !this.closed &&
      this.isWorktreeGenerationCurrent(
        descriptor.projectId,
        descriptor.worktreeId,
        generation,
      ) &&
      (descriptor.kind !== 'worktree-archive' ||
        this.isArchiveContentEpochCurrent(
          descriptor.projectId,
          descriptor.worktreeId,
          descriptor.archiveContentEpoch ?? 0,
        )) &&
      !this.isCoworkArchiveDeleted(descriptor.projectId, descriptor.chatId)
    ) {
      if (descriptor.kind === 'live') {
        this.syncedLiveScopes.add(
          this.liveUpdateKey(descriptor.projectId, descriptor.worktreeId),
        );
      }
      await indexer.setSourceFingerprint(
        descriptor.fileKey,
        descriptor.fingerprint,
      );
    }
  }

  /**
   * Replaces a scanned live scope; false when that did not complete. A newer
   * live update that supersedes it may index only its own chats, so a scope
   * not yet indexed whole is reread through the live update queue.
   */
  private async indexScannedLiveSource(
    descriptor: SourceDescriptor,
  ): Promise<boolean> {
    const { projectId, worktreeId } = descriptor;
    const generation = descriptor.worktreeGeneration;
    const contentEpoch = this.liveContentEpoch(projectId, worktreeId);
    try {
      const data = await readChatTabsFileForIndex(projectId, worktreeId);
      if (
        this.closed ||
        !this.isWorktreeGenerationCurrent(projectId, worktreeId, generation)
      ) {
        return false;
      }
      await this.replaceLiveScope(projectId, worktreeId, data, contentEpoch);
    } catch (error) {
      if (!(error instanceof StaleSearchProjectionError)) throw error;
    }
    if (this.isLiveContentEpochCurrent(projectId, worktreeId, contentEpoch)) {
      return true;
    }
    const updateKey = this.liveUpdateKey(projectId, worktreeId);
    if (
      !this.closed &&
      this.isWorktreeGenerationCurrent(projectId, worktreeId, generation) &&
      !this.syncedLiveScopes.has(updateKey) &&
      !this.currentFullLiveUpdate(updateKey, generation)
    ) {
      this.queueFullLiveUpdate({ projectId, worktreeId }, undefined);
    }
    return false;
  }

  private async indexCoworkArchiveSource(
    descriptor: SourceDescriptor,
    generation: number,
  ): Promise<void> {
    const chatId = descriptor.chatId;
    if (!chatId) return;
    const [snapshot, meta] = await Promise.all([
      readArchiveSnapshotForIndex(descriptor.projectId, chatId),
      readArchiveMetaForIndex(descriptor.projectId, chatId),
    ]);
    if (
      this.closed ||
      !this.isWorktreeGenerationCurrent(
        descriptor.projectId,
        descriptor.worktreeId,
        generation,
      ) ||
      this.isCoworkArchiveDeleted(descriptor.projectId, chatId)
    ) {
      return;
    }
    if (!snapshot && meta?.archived !== true) {
      await this.getIndexer().deleteChatDoc(
        descriptor.projectId,
        descriptor.worktreeId,
        chatId,
        'cowork-archive',
      );
      return;
    }
    const baseTab: PersistedChatTab = snapshot?.tab ?? {
      id: chatId,
      title: meta?.title ?? meta?.description ?? chatId,
      description: meta?.description,
      messages: [],
      createdAt: meta?.createdAt ?? new Date(0).toISOString(),
      providerType: meta?.providerType,
    };
    const tab: PersistedChatTab = {
      ...baseTab,
      ...(meta?.title ? { title: meta.title } : {}),
      ...(meta?.description ? { description: meta.description } : {}),
      ...(meta?.providerType ? { providerType: meta.providerType } : {}),
    };
    const doc = await this.projectedChat(
      descriptor.projectId,
      descriptor.worktreeId,
      'cowork-archive',
      tab,
      meta?.archivedAt ??
        snapshot?.archivedAt ??
        meta?.createdAt ??
        tab.createdAt,
    );
    if (
      !this.closed &&
      this.isWorktreeGenerationCurrent(
        descriptor.projectId,
        descriptor.worktreeId,
        generation,
      ) &&
      !this.isCoworkArchiveDeleted(descriptor.projectId, chatId)
    ) {
      await this.getIndexer().upsertDoc(doc);
      await this.reconcileChildDocuments(
        doc,
        (): boolean =>
          !this.closed &&
          this.isWorktreeGenerationCurrent(
            descriptor.projectId,
            descriptor.worktreeId,
            generation,
          ) &&
          !this.isCoworkArchiveDeleted(descriptor.projectId, chatId),
      );
    }
  }

  private async pruneMissingSources(sourceKeys: Set<string>): Promise<void> {
    const indexer = this.getIndexer();
    for (const fileKey of await indexer.listSourceFileKeys()) {
      if (!sourceKeys.has(fileKey)) await indexer.deleteSourceFile(fileKey);
    }
    const rows: unknown[] = this.getDatabase()
      .prepare(
        'SELECT doc_id, project_id, worktree_id, chat_id, source FROM chat_docs',
      )
      .all();
    for (const result of rows) {
      const row = requireSqliteRow(result);
      if (
        typeof row.doc_id !== 'string' ||
        typeof row.project_id !== 'string' ||
        typeof row.worktree_id !== 'string' ||
        typeof row.chat_id !== 'string' ||
        !isChatSearchSource(row.source)
      ) {
        continue;
      }
      const fileKey = this.sourceKeyForDoc(
        row.project_id,
        row.worktree_id,
        row.chat_id,
        row.source,
      );
      if (!sourceKeys.has(fileKey)) {
        await indexer.deleteDocById(row.doc_id);
      }
    }
  }

  private sourceKeyForDoc(
    projectId: string,
    worktreeId: string,
    chatId: string,
    source: ChatSearchSource,
  ): string {
    if (source === 'live') return this.liveFilePath(projectId, worktreeId);
    if (source === 'worktree-archive') {
      return this.worktreeArchiveFilePath(projectId, worktreeId);
    }
    if (source === 'plan') return this.plansFilePath(projectId, worktreeId);
    if (source === 'archived-container') {
      return getArchivedContainerManifestPath(projectId, worktreeId);
    }
    return this.coworkArchiveDir(projectId, chatId);
  }

  private normalizeLiveScope(
    projectId: string,
    worktreeId: string,
  ): { projectId: string; worktreeId: string } {
    if (projectId !== STANDALONE_CHAT_PROJECT_ID) {
      return { projectId, worktreeId };
    }
    return {
      projectId: resolveCoworkWorkspaceId(worktreeId),
      worktreeId: COWORK_HOME_WORKTREE_ID,
    };
  }

  private reactivateScope(projectId: string, worktreeId: string): void {
    this.hiddenLiveScopes.delete(`${projectId}/${worktreeId}`);
    this.deletedWorkspaces.delete(projectId);
    this.deletedWorktrees.delete(`${projectId}/${worktreeId}`);
  }

  private worktreeGeneration(projectId: string, worktreeId: string): number {
    return this.worktreeGenerations.get(`${projectId}/${worktreeId}`) ?? 0;
  }

  private liveContentEpoch(projectId: string, worktreeId: string): number {
    return this.liveContentEpochs.get(`${projectId}/${worktreeId}`) ?? 0;
  }

  private advanceLiveContentEpoch(
    projectId: string,
    worktreeId: string,
  ): number {
    const epoch = this.liveContentEpoch(projectId, worktreeId) + 1;
    this.liveContentEpochs.set(`${projectId}/${worktreeId}`, epoch);
    return epoch;
  }

  private isLiveContentEpochCurrent(
    projectId: string,
    worktreeId: string,
    epoch: number,
  ): boolean {
    return this.liveContentEpoch(projectId, worktreeId) === epoch;
  }

  private archiveContentEpoch(projectId: string, worktreeId: string): number {
    return this.archiveContentEpochs.get(`${projectId}/${worktreeId}`) ?? 0;
  }

  private advanceArchiveContentEpoch(
    projectId: string,
    worktreeId: string,
  ): number {
    const epoch = this.archiveContentEpoch(projectId, worktreeId) + 1;
    this.archiveContentEpochs.set(`${projectId}/${worktreeId}`, epoch);
    return epoch;
  }

  private isArchiveContentEpochCurrent(
    projectId: string,
    worktreeId: string,
    epoch: number,
  ): boolean {
    return this.archiveContentEpoch(projectId, worktreeId) === epoch;
  }

  private advanceWorktreeGeneration(
    projectId: string,
    worktreeId: string,
  ): number {
    for (const read of Array.from(this.childReads))
      if (read.projectId === projectId && read.worktreeId === worktreeId)
        read.controller.abort();
    const generation = this.worktreeGeneration(projectId, worktreeId) + 1;
    this.worktreeGenerations.set(`${projectId}/${worktreeId}`, generation);
    this.syncedLiveScopes.delete(this.liveUpdateKey(projectId, worktreeId));
    return generation;
  }

  private isWorktreeGenerationCurrent(
    projectId: string,
    worktreeId: string,
    generation: number,
  ): boolean {
    return (
      !this.isScopeDeleted(projectId, worktreeId) &&
      this.worktreeGeneration(projectId, worktreeId) === generation
    );
  }

  private isScopeDeleted(projectId: string, worktreeId: string): boolean {
    return (
      this.deletedWorkspaces.has(projectId) ||
      this.deletedWorktrees.has(`${projectId}/${worktreeId}`)
    );
  }

  private coworkArchiveKey(projectId: string, chatId: string): string {
    return `${projectId}/${chatId}`;
  }

  private isCoworkArchiveDeleted(
    projectId: string,
    chatId: string | undefined,
  ): boolean {
    return (
      chatId !== undefined &&
      this.deletedCoworkArchives.has(this.coworkArchiveKey(projectId, chatId))
    );
  }

  private async sourceFingerprint(
    fileKey: string,
    projectId: string,
    worktreeId: string,
  ): Promise<SourceFingerprint | null> {
    const live = fileKey === this.liveFilePath(projectId, worktreeId);
    const archive =
      fileKey === this.worktreeArchiveFilePath(projectId, worktreeId);
    if (live || archive) {
      const store = new ChatStorageV2(
        dirname(dirname(this.liveFilePath(projectId, worktreeId))),
        worktreeId,
        undefined,
        { maxManifestVersion: 4 },
      );
      const format = await store.format();
      if (format !== 'v1') {
        const index = await safeFingerprint(
          join(
            store.directory,
            live ? 'live-index.json' : 'archive-index.json',
          ),
        );
        if (!index) return index;
        const journalFile =
          format === 'v2' ? undefined : await store.journalFile();
        let childIdentity = 0;
        if (format === 'v4') {
          const state = (
            await import('../services/chat-state-service')
          ).getChatStateService();
          const scope = { projectId, worktreeId };
          const chats = live
            ? (await state.getCompatibilityTabs(scope, { chatIds: [] })).tabs
            : (
                await state.getCompatibilityArchives(scope, { chatIds: [] })
              ).archived.map((entry) => entry.tab);
          const hash = createHash('sha256');
          for (const chat of chats) {
            const children = await state.listChildSearchDocuments(
              scope,
              chat.id,
            );
            hash.update(
              JSON.stringify([
                chat.id,
                children.map((child) => child.fingerprint),
              ]),
            );
          }
          childIdentity = parseInt(hash.digest('hex').slice(0, 12), 16);
        }
        if (!journalFile)
          return { ...index, sizeBytes: index.sizeBytes + childIdentity };
        // A delta-journal scope's index file is only its last checkpoint;
        // every commit appends to the journal, and a checkpoint replaces it.
        const journal = await safeFingerprint(
          join(store.directory, journalFile),
        );
        if (!journal)
          return { ...index, sizeBytes: index.sizeBytes + childIdentity };
        return {
          mtimeMs: Math.max(index.mtimeMs, journal.mtimeMs),
          sizeBytes: index.sizeBytes + journal.sizeBytes + childIdentity,
        };
      }
    }
    return safeFingerprint(fileKey);
  }

  private async refreshFingerprint(
    fileKey: string,
    projectId: string,
    worktreeId: string,
    generation: number,
    archiveContentEpoch?: number,
    live?: LiveFingerprintFence,
  ): Promise<void> {
    const fingerprint =
      live?.fingerprint === undefined
        ? await this.sourceFingerprint(fileKey, projectId, worktreeId)
        : live.fingerprint;
    const isCurrent = (): boolean =>
      !this.closed &&
      this.isWorktreeGenerationCurrent(projectId, worktreeId, generation) &&
      (archiveContentEpoch === undefined ||
        this.isArchiveContentEpochCurrent(
          projectId,
          worktreeId,
          archiveContentEpoch,
        )) &&
      (live === undefined ||
        (this.isLiveContentEpochCurrent(
          projectId,
          worktreeId,
          live.contentEpoch,
        ) &&
          live.isSnapshotCurrent?.() !== false));
    if (!fingerprint || !isCurrent()) return;
    // Read after the fingerprint: a commit already on disk then was admitted
    // before the read, so an unchanged revision means the files hold none.
    if (
      live?.fingerprint === undefined &&
      live?.revision !== undefined &&
      ((await readCommittedLiveRevision(projectId, worktreeId)) !==
        live.revision ||
        !isCurrent())
    ) {
      return;
    }
    await this.getIndexer().setSourceFingerprint(fileKey, fingerprint);
  }

  private async runIncrementalTask(
    task: () => Promise<void> | void,
  ): Promise<void> {
    try {
      await task();
      await this.flushIndexer();
    } catch (error) {
      this.recoverFailedIndexer();
      throw error;
    }
    this.scheduleUpdatedBroadcast();
  }

  private scheduleUpdatedBroadcast(): void {
    if (this.closed) return;
    this.indexRevision += 1;
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      if (this.closed) return;
      try {
        this.broadcastUpdated();
      } catch (error) {
        // Search remains usable even if a renderer is being torn down while
        // the coalesced notification fires.
        // eslint-disable-next-line no-console
        console.error('Chat search update broadcast failed:', error);
      }
    }, this.broadcastDebounceMs);
    this.broadcastTimer.unref?.();
  }

  private liveUpdateKey(projectId: string, worktreeId: string): string {
    return `live:${projectId}/${worktreeId}`;
  }

  private liveFilePath(projectId: string, worktreeId: string): string {
    return getWorkspaceChatTabsFilePath(projectId, worktreeId);
  }

  private worktreeArchiveFilePath(
    projectId: string,
    worktreeId: string,
  ): string {
    return getWorkspaceChatArchivesFilePath(projectId, worktreeId);
  }

  private plansFilePath(projectId: string, worktreeId: string): string {
    return getWorkspaceTrackedPlansFilePath(projectId, worktreeId);
  }

  private coworkArchiveDir(projectId: string, chatId: string): string {
    return getWorkspaceChatHistoryDir(projectId, chatId);
  }
}

let service: ChatSearchService | null = null;

export function getChatSearchService(): ChatSearchService {
  service ??= new ChatSearchService();
  return service;
}

/** Does not instantiate the index during shutdown if search was never used. */
export async function closeChatSearchService(): Promise<void> {
  const current = service;
  service = null;
  await current?.close();
}
