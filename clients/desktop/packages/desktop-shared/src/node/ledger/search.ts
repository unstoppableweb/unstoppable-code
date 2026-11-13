import type { SQLInputValue } from 'node:sqlite';

import {
  LEDGER_LIMITS,
  LEDGER_STATUSES,
  LedgerSearchEntriesParamsSchema,
  LedgerUuidSchema,
  type LedgerActorFilter,
  type LedgerAttributionKind,
  type LedgerEntryType,
  type LedgerRootChatFilter,
  type LedgerSearchEntriesParams,
  type LedgerSearchSort,
  type LedgerSourceKind,
  type LedgerStatus,
} from '@canopy/protocol/canopy-core';

import { LedgerStoreError } from './errors';
import { hashLedgerCanonicalValue } from './hashing';
import { isLedgerEntryOpen } from './policy';
import { normalizeLedgerTimeBound } from './time';
import type { LedgerSearchEntriesInput } from './types';

/**
 * Literal search semantics.
 *
 * The query is split on whitespace into words, and every word must match.
 * Each word is passed to FTS5 as a quoted string, so FTS operators (`AND`,
 * `OR`, `NOT`, `NEAR`), column filters, a `*` typed by the person, grouping
 * and quotes are matched as ordinary text rather than interpreted. FTS
 * tokenizes a word the same way it indexed the entry: letters and digits are
 * compared case-insensitively with diacritics significant, and a word
 * containing punctuation (`foo-bar`) matches its parts as consecutive tokens.
 * Words with no letters or digits (punctuation, symbols, emoji) are not
 * indexed, so they are dropped; a query with no indexable word matches
 * nothing. A word's last token matches as a prefix, so a word matches the
 * start of a word as people type (`say h` finds "Say hello", `efix` does not
 * find "Prefix"); there is no stemmed matching.
 */
// Constructed at runtime: the package's compile target predates the `u` flag.
const INDEXABLE_CHARACTER = new RegExp('[\\p{L}\\p{N}\\p{Co}]', 'u');
const WORD_SEPARATOR = new RegExp('[\\s\\p{Cc}]+', 'u');

export function splitLedgerSearchWords(query: string): string[] {
  return query
    .split(WORD_SEPARATOR)
    .filter((word: string): boolean => INDEXABLE_CHARACTER.test(word));
}

/**
 * Every word must match, each by the start of a word, as people type: "say h"
 * finds "Say hello". A word is quoted, so its characters stay literal, and its
 * last token is a prefix (FTS5 `"word"*`).
 */
export function buildLedgerFtsQuery(words: readonly string[]): string {
  return words
    .map((word: string): string => `"${word.replace(/"/g, '""')}"*`)
    .join(' ');
}

/** Search filters after validation, normalization and hashing. */
export interface LedgerNormalizedSearch {
  readonly sort: LedgerSearchSort;
  readonly limit: number;
  /** Null without a query; empty when the query cannot match anything. */
  readonly words: readonly string[] | null;
  /** Internal store filter: null is unrestricted and [] intentionally matches nothing. */
  readonly ownerIn: readonly string[] | null;
  readonly openOnly: boolean;
  readonly entryIds: readonly string[] | null;
  readonly ownerActorId: string | null;
  readonly authorActorId: string | null;
  /** Undefined means unrestricted; null means a top-level entry. */
  readonly parentEntryId: string | null | undefined;
  readonly rootEntryId: string | null;
  readonly authorIn: readonly string[] | null;
  readonly sourceKinds: readonly LedgerSourceKind[] | null;
  readonly rootChat: {
    readonly rootOnly: boolean;
    readonly chatId: string | null;
  } | null;
  /** Owners under `rootChat.chatId`; derived, so left out of the filter hash. */
  readonly rootChatOwnerIn: readonly string[];
  readonly types: readonly LedgerEntryType[] | null;
  readonly statuses: readonly LedgerStatus[] | null;
  readonly attribution: readonly LedgerAttributionKind[] | null;
  readonly createdAfter: string | null;
  readonly createdBefore: string | null;
  readonly updatedAfter: string | null;
  readonly updatedBefore: string | null;
  /** SHA-256 of every normalized filter and the sort; excludes the limit. */
  readonly filterHash: string;
}

/** Protocol actor filters (`{ actorId }`) arrive as flat actor-ID inputs. */
const INPUT_FIELD_BY_PARAM: { readonly [param: string]: string } = {
  owner: 'ownerActorId',
  author: 'authorActorId',
};

const LEDGER_SEARCH_OWNER_IDS_MAX = 1_024;
const LEDGER_OPEN_STATUSES = LEDGER_STATUSES.filter(isLedgerEntryOpen);

function invalidSearchField(path: readonly PropertyKey[]): LedgerStoreError {
  const segments = path.map((segment: PropertyKey): string => String(segment));
  const head = segments[0];
  // A root-level issue (such as the request size limit) names no field.
  return new LedgerStoreError(
    'INVALID_INPUT',
    head === undefined
      ? {}
      : { field: INPUT_FIELD_BY_PARAM[head] ?? segments.join('.') },
  );
}

function uniqueSorted<Value extends string>(
  values: readonly Value[] | undefined,
): readonly Value[] | null {
  return values === undefined ? null : Array.from(new Set(values)).sort();
}

function ownerFilter(value: unknown): readonly string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > LEDGER_SEARCH_OWNER_IDS_MAX) {
    throw invalidSearchField(['ownerIn']);
  }
  const actorIds = new Set<string>();
  for (const actorId of value) {
    const parsed = LedgerUuidSchema.safeParse(actorId);
    if (!parsed.success) throw invalidSearchField(['ownerIn']);
    actorIds.add(parsed.data);
  }
  return Array.from(actorIds).sort();
}

function openOnlyFilter(value: unknown): boolean {
  if (value === undefined) return false;
  if (value !== true) throw invalidSearchField(['openOnly']);
  return true;
}

function timeBound(value: string | undefined, field: string): string | null {
  if (value === undefined) return null;
  const normalized = normalizeLedgerTimeBound(value);
  if (normalized === null) {
    throw new LedgerStoreError('INVALID_INPUT', { field });
  }
  return normalized;
}

function assertCompatibleRange(
  after: string | null,
  before: string | null,
  field: string,
): void {
  if (after !== null && before !== null && after >= before) {
    throw new LedgerStoreError('INVALID_INPUT', { field });
  }
}

type LedgerSearchFilters = Omit<LedgerNormalizedSearch, 'filterHash'>;

function rootChatFilter(
  filter: LedgerRootChatFilter | undefined,
): LedgerNormalizedSearch['rootChat'] {
  return filter === undefined
    ? null
    : { rootOnly: filter.rootOnly, chatId: filter.chatId ?? null };
}

function hashSearchFilters(filters: LedgerSearchFilters): string {
  return hashLedgerCanonicalValue({
    words: filters.words,
    ...(filters.ownerIn === null ? {} : { ownerIn: filters.ownerIn }),
    ...(filters.openOnly ? { openOnly: filters.openOnly } : {}),
    entryIds: filters.entryIds,
    ownerActorId: filters.ownerActorId,
    authorActorId: filters.authorActorId,
    parentEntryId: filters.parentEntryId,
    rootEntryId: filters.rootEntryId,
    authorIn: filters.authorIn,
    sourceKinds: filters.sourceKinds,
    ...(filters.rootChat === null ? {} : { rootChat: filters.rootChat }),
    types: filters.types,
    statuses: filters.statuses,
    attribution: filters.attribution,
    createdAfter: filters.createdAfter,
    createdBefore: filters.createdBefore,
    updatedAfter: filters.updatedAfter,
    updatedBefore: filters.updatedBefore,
    sort: filters.sort,
  });
}

function actorFilter(
  actorId: string | undefined,
): { readonly actorId: string } | undefined {
  return actorId === undefined ? undefined : { actorId };
}

function filterActorId(filter: LedgerActorFilter | undefined): string | null {
  return typeof filter === 'object' ? filter.actorId : null;
}

function parseSearchParams(
  input: LedgerSearchEntriesInput,
): LedgerSearchEntriesParams {
  const parsed = LedgerSearchEntriesParamsSchema.safeParse({
    query: input.query,
    entryIds: input.entryIds,
    owner: actorFilter(input.ownerActorId),
    author: actorFilter(input.authorActorId),
    parentEntryId: input.parentEntryId,
    rootEntryId: input.rootEntryId,
    authorIn: input.authorIn,
    sourceKinds: input.sourceKinds,
    rootChat: input.rootChat,
    types: input.types,
    statuses: input.statuses,
    attribution: input.attribution,
    createdAfter: input.createdAfter,
    createdBefore: input.createdBefore,
    updatedAfter: input.updatedAfter,
    updatedBefore: input.updatedBefore,
    sort: input.sort,
    limit: input.limit,
    cursor: input.cursor,
  });
  if (!parsed.success) {
    throw invalidSearchField(parsed.error.issues[0]?.path ?? []);
  }
  return parsed.data;
}

/**
 * Validates search input with the protocol schema, normalizes it (sorted
 * unique arrays, UTC time bounds, literal words) and hashes the filters so a
 * cursor can detect a change of filters between pages.
 */
export function normalizeLedgerSearch(
  input: LedgerSearchEntriesInput,
): LedgerNormalizedSearch {
  const params = parseSearchParams(input);
  const filters: LedgerSearchFilters = {
    sort: params.sort ?? 'created_desc',
    limit: params.limit ?? LEDGER_LIMITS.searchPageDefault,
    words:
      params.query === undefined ? null : splitLedgerSearchWords(params.query),
    ownerIn: ownerFilter(input.ownerIn),
    openOnly: openOnlyFilter(input.openOnly),
    entryIds: uniqueSorted(params.entryIds),
    ownerActorId: filterActorId(params.owner),
    authorActorId: filterActorId(params.author),
    parentEntryId: params.parentEntryId,
    rootEntryId: params.rootEntryId ?? null,
    authorIn: uniqueSorted(params.authorIn),
    sourceKinds: uniqueSorted(params.sourceKinds),
    rootChat: rootChatFilter(params.rootChat),
    rootChatOwnerIn: ownerFilter(input.rootChatOwnerIn) ?? [],
    types: uniqueSorted(params.types),
    statuses: uniqueSorted(params.statuses),
    attribution: uniqueSorted(params.attribution),
    createdAfter: timeBound(params.createdAfter, 'createdAfter'),
    createdBefore: timeBound(params.createdBefore, 'createdBefore'),
    updatedAfter: timeBound(params.updatedAfter, 'updatedAfter'),
    updatedBefore: timeBound(params.updatedBefore, 'updatedBefore'),
  };
  assertCompatibleRange(
    filters.createdAfter,
    filters.createdBefore,
    'createdBefore',
  );
  assertCompatibleRange(
    filters.updatedAfter,
    filters.updatedBefore,
    'updatedBefore',
  );
  return { ...filters, filterHash: hashSearchFilters(filters) };
}

/** Where a page starts inside the snapshot. */
export interface LedgerSearchPagePosition {
  /** Scope-sequence watermark of the snapshot. */
  readonly watermark: number;
  /** Sort key of the previous page's last item, or null for page one. */
  readonly after: {
    readonly sortValue: string;
    readonly entryId: string;
  } | null;
}

export interface LedgerSqlStatement {
  readonly sql: string;
  readonly params: SQLInputValue[];
}

class ClauseBuilder {
  readonly clauses: string[] = [];
  readonly params: SQLInputValue[] = [];

  equals(column: string, value: string | null): void {
    if (value === null) return;
    this.clauses.push(`${column} = ?`);
    this.params.push(value);
  }

  oneOf(column: string, values: readonly string[] | null): void {
    if (values === null) return;
    this.clauses.push(
      `${column} IN (${values.map((): string => '?').join(', ')})`,
    );
    this.params.push(...values);
  }

  compare(column: string, operator: '>=' | '<', value: string | null): void {
    if (value === null) return;
    this.clauses.push(`${column} ${operator} ?`);
    this.params.push(value);
  }

  raw(clause: string, ...params: SQLInputValue[]): void {
    this.clauses.push(clause);
    this.params.push(...params);
  }
}

/**
 * Builds one snapshot page. Each entry contributes its latest version at or
 * below the watermark, so entries created after the first page are excluded
 * and a status or owner change between pages cannot move an entry out of, or
 * back into, the result set. Filters and the cursor position are applied in
 * SQL before any row is hydrated.
 *
 * While nothing in the scope changed after the snapshot (its watermark is at
 * or past `currentSequence`, the scope's sequence now), every entry's version
 * at the watermark is its current row: the repository writes an entry's row
 * and its version in one transaction, from the same entry. So the page reads
 * `ledger_entries` alone, in the order of its sort index, instead of finding
 * each entry's version and sorting them all. Every first page is such a page.
 */
export function buildLedgerSearchPageStatement(
  ledgerId: string,
  search: LedgerNormalizedSearch,
  position: LedgerSearchPagePosition,
  fetchLimit: number,
  currentSequence: number,
): LedgerSqlStatement {
  const unchanged = position.watermark >= currentSequence;
  // The row each entry contributes: its current row, or its version.
  const row = unchanged ? 'e' : 'v';
  const sortColumn =
    search.sort === 'updated_desc' ? `${row}.updated_at` : `${row}.created_at`;
  const where = new ClauseBuilder();
  where.equals('e.ledger_id', ledgerId);
  if (search.ownerIn !== null) {
    if (search.ownerIn.length === 0) {
      where.raw('0');
    } else {
      where.raw(
        `${row}.owner_actor_id IN (SELECT value FROM json_each(?))`,
        JSON.stringify(search.ownerIn),
      );
    }
  }
  where.oneOf(`${row}.entry_id`, search.entryIds);
  where.equals(`${row}.owner_actor_id`, search.ownerActorId);
  where.equals(`${row}.author_actor_id`, search.authorActorId);
  if (search.parentEntryId === null) {
    where.raw(`${row}.parent_entry_id IS NULL`);
  } else {
    where.equals(`${row}.parent_entry_id`, search.parentEntryId ?? null);
  }
  if (search.rootEntryId !== null) {
    const membershipSequenceFilter = unchanged
      ? 'AND membership.to_sequence IS NULL'
      : `AND membership.from_sequence <= ?
          AND (membership.to_sequence IS NULL OR membership.to_sequence > ?)`;
    where.raw(
      `EXISTS (
        SELECT 1 FROM ledger_entry_roots AS membership
        WHERE membership.entry_rowid = e.entry_rowid
          AND membership.ledger_id = e.ledger_id
          AND membership.root_entry_id = ?
          ${membershipSequenceFilter}
      )`,
      search.rootEntryId,
      ...(unchanged ? [] : [position.watermark, position.watermark]),
    );
  }
  where.oneOf(`${row}.author_actor_id`, search.authorIn);
  if (search.sourceKinds !== null) {
    const sourceKindExpression = `CASE json_extract(${row}.projection_json, '$.origin.kind')
      WHEN 'chat' THEN 'chat'
      WHEN 'pipeline_agent' THEN 'pipeline'
      WHEN 'summary' THEN 'summary'
      WHEN 'managed_delegation' THEN CASE json_extract(${row}.projection_json, '$.origin.root.kind')
        WHEN 'chat' THEN 'chat'
        WHEN 'pipeline_agent' THEN 'pipeline'
        ELSE NULL
      END
      ELSE NULL
    END`;
    where.oneOf(sourceKindExpression, search.sourceKinds);
  }
  if (search.rootChat !== null) {
    // The origin is the creator's: an update keeps the entry's origin.
    const origin = (path: string): string =>
      `json_extract(${row}.projection_json, '$.origin${path}')`;
    const { rootOnly, chatId } = search.rootChat;
    if (rootOnly) {
      where.raw(`${origin('.kind')} = 'chat'`);
      if (chatId !== null) where.raw(`${origin('.chatId')} = ?`, chatId);
    } else {
      // The chat itself, a delegate under it, or anyone it or they own for.
      where.raw(
        `((${origin('.kind')} = 'chat' AND ${origin('.chatId')} = ?)
          OR (${origin('.kind')} = 'managed_delegation'
            AND ${origin('.root.kind')} = 'chat'
            AND ${origin('.root.chatId')} = ?)
          OR ${row}.owner_actor_id IN (SELECT value FROM json_each(?)))`,
        chatId,
        chatId,
        JSON.stringify(search.rootChatOwnerIn),
      );
    }
  }
  where.oneOf(`${row}.type`, search.types);
  where.oneOf(`${row}.status`, search.statuses);
  if (search.openOnly) where.oneOf(`${row}.status`, LEDGER_OPEN_STATUSES);
  where.oneOf(`${row}.attribution_kind`, search.attribution);
  where.compare(`${row}.created_at`, '>=', search.createdAfter);
  where.compare(`${row}.created_at`, '<', search.createdBefore);
  where.compare(`${row}.updated_at`, '>=', search.updatedAfter);
  where.compare(`${row}.updated_at`, '<', search.updatedBefore);
  if (search.words !== null) {
    where.raw(
      'e.entry_rowid IN (SELECT rowid FROM ledger_search WHERE ledger_search MATCH ?)',
      buildLedgerFtsQuery(search.words),
    );
  }
  if (position.after !== null) {
    where.raw(
      `(${sortColumn} < ? OR (${sortColumn} = ? AND ${row}.entry_id < ?))`,
      position.after.sortValue,
      position.after.sortValue,
      position.after.entryId,
    );
  }
  const select = `SELECT ${row}.projection_json AS projection_json,
      ${row}.scope_sequence AS scope_sequence,
      json_extract(mutation.mutation_json, '$.leftOpen') AS left_open_reason,
      mutation.occurred_at AS left_open_at
    FROM ledger_entries AS e`;
  const mutationJoin = `LEFT JOIN ledger_mutations AS mutation
      ON mutation.entry_rowid = e.entry_rowid AND mutation.revision = ${row}.revision`;
  const page = `WHERE ${where.clauses.join(' AND ')}
    ORDER BY ${sortColumn} DESC, ${row}.entry_id DESC
    LIMIT ?`;
  if (unchanged) {
    return {
      sql: `${select}
    ${mutationJoin}
    ${page}`,
      params: [...where.params, fetchLimit],
    };
  }
  const sql = `${select}
    JOIN ledger_entry_versions AS v ON v.version_rowid = (
      SELECT snapshot.version_rowid
      FROM ledger_entry_versions AS snapshot
      WHERE snapshot.entry_rowid = e.entry_rowid
        AND snapshot.scope_sequence <= ?
      ORDER BY snapshot.scope_sequence DESC
      LIMIT 1
    )
    ${mutationJoin}
    ${page}`;
  return {
    sql,
    params: [position.watermark, ...where.params, fetchLimit],
  };
}
