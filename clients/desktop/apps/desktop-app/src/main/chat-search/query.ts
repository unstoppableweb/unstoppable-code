import type { DatabaseSync } from 'node:sqlite';
import {
  type ChatSearchCatalogEntry,
  type ChatSearchChildLocator,
  type ChatSearchDocumentKind,
  type ChatSearchMatchRange,
  type ChatSearchQueryRequest,
  type ChatSearchResult,
  type TrackedPlanReviewStatus,
} from '@canopy/desktop-shared/types';
import { requireSqliteRow } from './sqlite-rows';

const DEFAULT_QUERY_LIMIT = 20;
const MAX_QUERY_LIMIT = 100;
const MATCH_START = '\u0001';
const MATCH_END = '\u0002';
const SNIPPET_ELLIPSIS = ' … ';

const CHAT_SEARCH_SOURCES = [
  'live',
  'worktree-archive',
  'cowork-archive',
  'plan',
  'archived-container',
] as const;

const PLAN_REVIEW_STATUSES: readonly TrackedPlanReviewStatus[] = [
  'pending',
  'approved',
  'dismissed',
];

const DOCUMENT_KINDS: readonly ChatSearchDocumentKind[] = [
  'chat',
  'chat-child',
  'plan',
  'archived-container',
];

function asDocumentKind(
  value: unknown,
  source: ChatSearchCatalogEntry['source'],
): ChatSearchDocumentKind {
  const kind = DOCUMENT_KINDS.find((candidate) => candidate === value);
  return kind ?? (source === 'plan' ? 'plan' : 'chat');
}

function isChatSearchSource(
  value: unknown,
): value is ChatSearchCatalogEntry['source'] {
  return (
    typeof value === 'string' &&
    CHAT_SEARCH_SOURCES.some((source) => source === value)
  );
}

function asPlanReviewStatus(value: unknown): TrackedPlanReviewStatus | null {
  return PLAN_REVIEW_STATUSES.find((status) => status === value) ?? null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  return null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function mapChatSearchCatalogRow(
  row: Record<string, unknown>,
): ChatSearchCatalogEntry {
  const source = row.source;
  if (!isChatSearchSource(source)) {
    throw new Error('Invalid chat search source');
  }
  const docId = row.doc_id;
  const projectId = row.project_id;
  const worktreeId = row.worktree_id;
  const chatId = row.chat_id;
  const title = row.title;
  const updatedAt = asFiniteNumber(row.updated_at);
  const archivedAt = asFiniteNumber(row.archived_at);
  const expiresAt = asFiniteNumber(row.expires_at);
  const messageCount = asFiniteNumber(row.message_count);
  if (
    typeof docId !== 'string' ||
    typeof projectId !== 'string' ||
    typeof worktreeId !== 'string' ||
    typeof chatId !== 'string' ||
    typeof title !== 'string' ||
    updatedAt === null ||
    messageCount === null
  ) {
    throw new Error('Invalid chat search catalog row');
  }
  const documentKind = asDocumentKind(row.document_kind, source);
  let childLocator: ChatSearchChildLocator | undefined;
  if (documentKind === 'chat-child') {
    const parentDocId = row.parent_doc_id;
    const delegationId = row.delegation_id;
    const runGeneration = asFiniteNumber(row.run_generation);
    const expectedParentDocId = `${projectId}/${worktreeId}/${chatId}/${source}`;
    if (
      parentDocId !== expectedParentDocId ||
      typeof delegationId !== 'string' ||
      delegationId.length === 0 ||
      runGeneration === null ||
      !Number.isSafeInteger(runGeneration) ||
      runGeneration < 0 ||
      docId !==
        `chat-child:${JSON.stringify([
          projectId,
          worktreeId,
          chatId,
          source,
          delegationId,
          runGeneration,
        ])}`
    ) {
      throw new Error('Invalid child chat search catalog row');
    }
    childLocator = { delegationId, runGeneration };
  }
  return {
    docId,
    projectId,
    worktreeId,
    chatId,
    source,
    documentKind,
    ...(childLocator === undefined ? {} : { childLocator }),
    title,
    description: asNullableString(row.description),
    providerType: asNullableString(row.provider_type),
    updatedAt,
    archivedAt,
    expiresAt,
    messageCount,
    reviewStatus: asPlanReviewStatus(row.review_status),
  };
}

/** Converts arbitrary palette input into an FTS5-safe AND-prefix query. */
export function sanitizeChatSearchQuery(query: string): string | null {
  const tokens = query.match(/[A-Za-z0-9_\u0080-\uFFFF]+/g);
  if (!tokens?.length) return null;
  return tokens.map((token) => `"${token}"*`).join(' ');
}

export function parseChatSearchSnippet(markedSnippet: string): {
  snippet: string;
  matchRanges: ChatSearchMatchRange[];
} {
  let snippet = '';
  let matchStart: number | null = null;
  const matchRanges: ChatSearchMatchRange[] = [];
  for (const character of markedSnippet) {
    if (character === MATCH_START) {
      if (matchStart === null) matchStart = snippet.length;
      continue;
    }
    if (character === MATCH_END) {
      if (matchStart !== null) {
        if (snippet.length > matchStart) {
          matchRanges.push({ start: matchStart, end: snippet.length });
        }
        matchStart = null;
      }
      continue;
    }
    snippet += character;
  }
  if (matchStart !== null && snippet.length > matchStart) {
    matchRanges.push({ start: matchStart, end: snippet.length });
  }
  return { snippet, matchRanges };
}

export function normalizeQueryRequest(request: ChatSearchQueryRequest): {
  ftsQuery: string;
  limit: number;
} | null {
  const ftsQuery = sanitizeChatSearchQuery(request.query);
  if (!ftsQuery) return null;
  const requestedLimit = request.limit;
  const limit =
    typeof requestedLimit === 'number' && Number.isFinite(requestedLimit)
      ? Math.min(MAX_QUERY_LIMIT, Math.max(0, Math.trunc(requestedLimit)))
      : DEFAULT_QUERY_LIMIT;
  return limit === 0 ? null : { ftsQuery, limit };
}

/** Rank all matching transcript rows, collapse to one parent, then paginate. */
export function queryChatSearchDatabase(
  db: DatabaseSync,
  request: ChatSearchQueryRequest,
  now = Date.now(),
  offset = 0,
): ChatSearchResult[] {
  const normalized = normalizeQueryRequest(request);
  if (!normalized) return [];
  const start = Math.max(0, Math.trunc(offset));
  const statement = db.prepare(
    `WITH matching AS MATERIALIZED (
       SELECT d.doc_id, d.project_id, d.worktree_id, d.chat_id, d.source,
              d.document_kind, d.title, d.description, d.provider_type,
              d.updated_at, d.archived_at, d.expires_at, d.message_count,
              d.review_status, d.parent_doc_id, d.delegation_id,
              d.run_generation, chat_fts.rowid AS fts_rowid,
              bm25(chat_fts) AS match_rank
       FROM chat_fts
       JOIN chat_docs d ON d.doc_id = chat_fts.doc_id
       WHERE body MATCH ?
         AND (d.expires_at IS NULL OR d.expires_at > ?)
     ), ranked AS (
       SELECT *, ROW_NUMBER() OVER (
         PARTITION BY project_id, worktree_id, chat_id
         ORDER BY match_rank, doc_id, fts_rowid
       ) AS parent_rank
       FROM matching
     ), page AS MATERIALIZED (
       SELECT * FROM ranked
       WHERE parent_rank = 1
       ORDER BY match_rank, doc_id, fts_rowid
       LIMIT ? OFFSET ?
     )
     SELECT page.doc_id, page.project_id, page.worktree_id, page.chat_id,
            page.source, page.document_kind, page.title, page.description,
            page.provider_type, page.updated_at, page.archived_at,
            page.expires_at, page.message_count, page.review_status,
            page.parent_doc_id, page.delegation_id, page.run_generation,
            snippet(chat_fts, 2, ?, ?, ?, 24) AS marked_snippet
     FROM page JOIN chat_fts ON chat_fts.rowid = page.fts_rowid
     WHERE chat_fts MATCH ?
     ORDER BY page.match_rank, page.doc_id, page.fts_rowid`,
  );
  const rows: unknown[] = statement.all(
    normalized.ftsQuery,
    now,
    normalized.limit,
    start,
    MATCH_START,
    MATCH_END,
    SNIPPET_ELLIPSIS,
    normalized.ftsQuery,
  );
  return rows.map((result) => {
    const row = requireSqliteRow(result);
    const catalogEntry = mapChatSearchCatalogRow(row);
    const markedSnippet =
      typeof row.marked_snippet === 'string' ? row.marked_snippet : '';
    return { ...catalogEntry, ...parseChatSearchSnippet(markedSnippet) };
  });
}

/**
 * FTS can rank a hit cheaply, but snippet() materializes and scans the full
 * matching body. Probe the aggregate byte length of the ranked rows a query
 * page projects so normal chats stay on the low-latency in-process path and an
 * oversized body or page of collectively large matches can be projected in a
 * utility process.
 */
export function chatSearchQueryExceedsBodyThreshold(
  db: DatabaseSync,
  request: ChatSearchQueryRequest,
  thresholdBytes: number,
  now = Date.now(),
): boolean {
  const normalized = normalizeQueryRequest(request);
  if (!normalized) return false;
  const rows: unknown[] = db
    .prepare(
      `WITH matching AS MATERIALIZED (
       SELECT d.doc_id, d.parent_doc_id, chat_fts.rowid AS fts_rowid,
                d.project_id, d.worktree_id, d.chat_id,
                bm25(chat_fts) AS match_rank
         FROM chat_fts
         JOIN chat_docs d ON d.doc_id = chat_fts.doc_id
         WHERE body MATCH ?
           AND (d.expires_at IS NULL OR d.expires_at > ?)
       ), ranked AS (
         SELECT *, ROW_NUMBER() OVER (
           PARTITION BY project_id, worktree_id, chat_id
           ORDER BY match_rank, doc_id, fts_rowid
         ) AS parent_rank
         FROM matching
       )
       SELECT length(CAST(chat_fts.body AS BLOB)) AS body_bytes
       FROM ranked JOIN chat_fts ON chat_fts.rowid = ranked.fts_rowid
       WHERE parent_rank = 1
       ORDER BY ranked.match_rank, ranked.doc_id, ranked.fts_rowid
       LIMIT ?`,
    )
    .all(normalized.ftsQuery, now, normalized.limit);
  let projectedBytes = 0;
  for (const value of rows) {
    const bytes = requireSqliteRow(value).body_bytes;
    if (typeof bytes !== 'number' && typeof bytes !== 'bigint') continue;
    projectedBytes += Number(bytes);
    if (projectedBytes > thresholdBytes) return true;
  }
  return false;
}
