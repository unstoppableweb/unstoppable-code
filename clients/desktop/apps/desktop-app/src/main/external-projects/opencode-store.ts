import type { DatabaseSync } from 'node:sqlite';
import { isRecord } from '../lib/type-guards';
import { StoreSchemaError, requireTables } from './sqlite-snapshot';

/**
 * Pure readers over a copy of OpenCode's `opencode.db`. They run in the store
 * read worker, so they hold no state and never touch the filesystem; the
 * adapter (`opencode-discovery.ts`) decides what the rows mean.
 *
 * Only the allowlisted tables and columns below are read. The database also
 * holds account and credential tables, a key-value store, and an event log;
 * discovery has no use for them and never queries them.
 */

/**
 * The columns the snapshot selects, checked before reading so a store from an
 * incompatible OpenCode version fails with a named column rather than a SQL
 * error. `migration` is last so a miss names real data first.
 */
export const OPENCODE_REQUIRED_TABLES: Record<string, string[]> = {
  project: ['id', 'worktree', 'vcs', 'name', 'time_active', 'time_archived'],
  worktree: ['project_id', 'directory'],
  session_v2: [
    'id',
    'project_id',
    'parent_id',
    'directory',
    'title',
    'version',
    'model',
    'time_created',
    'time_updated',
    'time_archived',
  ],
  session_message: ['session_id', 'data'],
  migration: ['id'],
};

export interface OpenCodeProject {
  id: string;
  /** The project's main checkout; linked worktrees are in `worktreeDirectories`. */
  worktree: string;
  vcs: string | null;
  name: string | null;
  timeActive: number;
  timeArchived: number | null;
  /** Every `worktree.directory` row of the project, main checkout included. */
  worktreeDirectories: string[];
}

export interface OpenCodeSession {
  id: string;
  projectId: string;
  /** Where the session ran: a linked worktree for a project keyed by its main checkout. */
  directory: string;
  title: string | null;
  version: string;
  /** The recorded model id (`model.id` of the stored JSON), if any. */
  model: string | null;
  /** Epoch milliseconds. */
  timeCreated: number;
  timeUpdated: number;
  timeArchived: number | null;
  /** SUM of `length(data)` over the session's messages: its text copy's size. */
  messageBytes: number;
}

export interface OpenCodeSnapshot {
  projects: OpenCodeProject[];
  /** Top-level sessions only, newest `time_updated` first. */
  sessions: OpenCodeSession[];
  /** The newest applied migration id, for a schema diagnostic. */
  migrationMax: string | null;
}

/** One `session_message` row of a type the import projects. */
export interface OpenCodeMessageRow {
  id: string;
  type: string;
  seq: number;
  /** Epoch milliseconds. */
  timeCreated: number;
  /** The decoded `data` JSON. */
  data: Record<string, unknown>;
}

/** What the `sessions` request returns, by session id; unknown ids are absent. */
export type OpenCodeSessionDetails = Record<string, OpenCodeMessageRow[]>;

/**
 * Message types the projection renders. The rest (`idle`, `model-switched`,
 * `system`, `synthetic`, agent and location switches, skills, shells) are
 * bookkeeping or injected context and stay in the store.
 */
const OPENCODE_PROJECTED_TYPES = ['user', 'assistant', 'compaction'];

/** Columns the `sessions` read selects, checked like the snapshot's. */
const OPENCODE_SESSION_TABLES: Record<string, string[]> = {
  session_message: ['id', 'session_id', 'type', 'seq', 'time_created', 'data'],
};

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function count(value: unknown): number {
  if (typeof value === 'bigint') return Number(value);
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function countOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : count(value);
}

function rows(
  db: DatabaseSync,
  sql: string,
  ...params: Array<number | string>
): Record<string, unknown>[] {
  return db
    .prepare(sql)
    .all(...params)
    .filter(isRecord);
}

/** Migration ids start with a timestamp, so the largest id is the newest. */
function readMigrationMax(db: DatabaseSync): string | null {
  try {
    const [row] = rows(db, 'select max(id) as newest from migration');
    return row ? text(row.newest) : null;
  } catch {
    return null;
  }
}

/**
 * Reads every OpenCode project and the newest `maxSessions` top-level
 * sessions. Child (subagent) sessions are dropped here: they are part of
 * their parent's transcript, not chats of their own. Throws
 * {@link StoreSchemaError} naming the first missing column and the store's
 * newest migration when the layout is not the one this reader was written
 * against.
 */
export function readOpenCodeSnapshot(
  db: DatabaseSync,
  maxSessions: number,
): OpenCodeSnapshot {
  const missing = requireTables(db, OPENCODE_REQUIRED_TABLES);
  if (missing) {
    throw new StoreSchemaError(
      `${missing} (newest migration: ${readMigrationMax(db) ?? 'unknown'})`,
    );
  }

  const directoriesByProject = new Map<string, string[]>();
  for (const row of rows(
    db,
    'select project_id, directory from worktree order by project_id, directory',
  )) {
    const projectId = text(row.project_id);
    const directory = text(row.directory);
    if (!projectId || !directory) continue;
    const list = directoriesByProject.get(projectId) ?? [];
    list.push(directory);
    directoriesByProject.set(projectId, list);
  }

  const projects: OpenCodeProject[] = [];
  for (const row of rows(
    db,
    `select id, worktree, vcs, name, time_active, time_archived
     from project order by id`,
  )) {
    const id = text(row.id);
    const worktree = text(row.worktree);
    if (!id || !worktree) continue;
    projects.push({
      id,
      worktree,
      vcs: text(row.vcs),
      name: text(row.name)?.trim() || null,
      timeActive: count(row.time_active),
      timeArchived: countOrNull(row.time_archived),
      worktreeDirectories: directoriesByProject.get(id) ?? [],
    });
  }

  const sessions: OpenCodeSession[] = [];
  for (const row of rows(
    db,
    // `json_valid` first: one corrupt model string must not fail the whole read.
    `select s.id, s.project_id, s.directory, s.title, s.version,
       case when json_valid(s.model) then json_extract(s.model, '$.id') end as model_id,
       s.time_created, s.time_updated, s.time_archived,
       (select coalesce(sum(length(cast(m.data as blob))), 0) from session_message m where m.session_id = s.id) as message_bytes
     from session_v2 s
     where s.parent_id is null
     order by s.time_updated desc, s.id
     limit ?`,
    maxSessions,
  )) {
    const id = text(row.id);
    const projectId = text(row.project_id);
    const directory = text(row.directory);
    if (!id || !projectId || !directory) continue;
    sessions.push({
      id,
      projectId,
      directory,
      title: text(row.title),
      version: text(row.version) ?? '',
      model: text(row.model_id),
      timeCreated: count(row.time_created),
      timeUpdated: count(row.time_updated),
      timeArchived: countOrNull(row.time_archived),
      messageBytes: count(row.message_bytes),
    });
  }

  return { projects, sessions, migrationMax: readMigrationMax(db) };
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Reads the selected sessions' messages for the import, ordered by `seq`, with
 * only the types the projection renders. A row whose `data` is not a JSON
 * object is skipped rather than failing the session.
 */
export function readOpenCodeSessions(
  db: DatabaseSync,
  sessionIds: string[],
): OpenCodeSessionDetails {
  const missing = requireTables(db, OPENCODE_SESSION_TABLES);
  if (missing) {
    throw new StoreSchemaError(
      `${missing} (newest migration: ${readMigrationMax(db) ?? 'unknown'})`,
    );
  }
  const details = new Map<string, OpenCodeMessageRow[]>();
  for (const row of rows(
    db,
    `select id, session_id, type, seq, time_created, data
     from session_message
     where session_id in (select value from json_each(?))
       and type in (select value from json_each(?))
     order by session_id, seq, id`,
    JSON.stringify(Array.from(new Set(sessionIds))),
    JSON.stringify(OPENCODE_PROJECTED_TYPES),
  )) {
    const sessionId = text(row.session_id);
    const id = text(row.id);
    const type = text(row.type);
    const data = parseRecord(row.data);
    if (!sessionId || !id || !type || !data) continue;
    const list = details.get(sessionId) ?? [];
    list.push({
      id,
      type,
      seq: count(row.seq),
      timeCreated: count(row.time_created),
      data,
    });
    details.set(sessionId, list);
  }
  return Object.fromEntries(details);
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || typeof value === 'number';
}

function isOpenCodeProject(value: unknown): value is OpenCodeProject {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.worktree === 'string' &&
    isStringOrNull(value.vcs) &&
    isStringOrNull(value.name) &&
    typeof value.timeActive === 'number' &&
    isNumberOrNull(value.timeArchived) &&
    Array.isArray(value.worktreeDirectories) &&
    value.worktreeDirectories.every((dir) => typeof dir === 'string')
  );
}

function isOpenCodeSession(value: unknown): value is OpenCodeSession {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.projectId === 'string' &&
    typeof value.directory === 'string' &&
    isStringOrNull(value.title) &&
    typeof value.version === 'string' &&
    isStringOrNull(value.model) &&
    typeof value.timeCreated === 'number' &&
    typeof value.timeUpdated === 'number' &&
    isNumberOrNull(value.timeArchived) &&
    typeof value.messageBytes === 'number'
  );
}

/** Narrows the worker's untyped `data` to a snapshot before the adapter trusts it. */
export function isOpenCodeSnapshot(value: unknown): value is OpenCodeSnapshot {
  return (
    isRecord(value) &&
    Array.isArray(value.projects) &&
    value.projects.every(isOpenCodeProject) &&
    Array.isArray(value.sessions) &&
    value.sessions.every(isOpenCodeSession) &&
    isStringOrNull(value.migrationMax)
  );
}

function isOpenCodeMessageRow(value: unknown): value is OpenCodeMessageRow {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.type === 'string' &&
    typeof value.seq === 'number' &&
    typeof value.timeCreated === 'number' &&
    isRecord(value.data)
  );
}

/** Narrows the worker's untyped `data` to session messages before the import trusts it. */
export function isOpenCodeSessionDetails(
  value: unknown,
): value is OpenCodeSessionDetails {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (rows) => Array.isArray(rows) && rows.every(isOpenCodeMessageRow),
    )
  );
}
