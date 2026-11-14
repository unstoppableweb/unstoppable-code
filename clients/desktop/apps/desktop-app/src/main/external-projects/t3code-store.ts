import type { DatabaseSync } from 'node:sqlite';
import { isRecord } from '../lib/type-guards';
import { StoreSchemaError, requireTables } from './sqlite-snapshot';

/**
 * Pure readers over a copy of T3 Code's `statev2.sqlite`. They run in the
 * store read worker, so they hold no state and never touch the filesystem;
 * the adapter (`t3code-discovery.ts`) decides what the rows mean.
 *
 * Only the allowlisted tables and columns below are read. The store also
 * holds an event log and provider session payloads that discovery has no use
 * for, and `userdata/secrets/` and `clerk/` are never opened at all.
 */

/**
 * The columns the snapshot selects, checked before reading so a store from an
 * incompatible T3 Code version fails with a named column rather than a SQL
 * error. `effect_sql_migrations` is last so a miss names real data first.
 */
export const T3_REQUIRED_TABLES: Record<string, string[]> = {
  projection_projects: [
    'project_id',
    'title',
    'workspace_root',
    'created_at',
    'updated_at',
    'deleted_at',
    'archived_at',
  ],
  orchestration_v2_projection_threads: [
    'thread_id',
    'project_id',
    'title',
    'active_provider_thread_id',
    'provider_instance_id',
    'created_at',
    'updated_at',
    'archived_at',
    'deleted_at',
    'payload_json',
  ],
  orchestration_v2_projection_provider_threads: [
    'provider_thread_id',
    'thread_id',
    'provider',
    'driver',
    'provider_instance_id',
    'updated_at',
    'payload_json',
  ],
  orchestration_v2_projection_messages: ['thread_id', 'payload_json'],
  orchestration_v2_projection_turn_items: ['thread_id', 'type', 'payload_json'],
  effect_sql_migrations: ['migration_id'],
};

export interface T3Project {
  projectId: string;
  title: string;
  workspaceRoot: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface T3Thread {
  threadId: string;
  projectId: string;
  title: string;
  /** T3's driver id for the provider thread backing this thread, if any. */
  driver: string | null;
  /** The agent's own session id (`nativeThreadRef.nativeId`), if T3 recorded one. */
  nativeId: string | null;
  worktreePath: string | null;
  providerInstanceId: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  /**
   * UTF-8 bytes of `payload_json` over the thread's messages and the turn
   * items the history import reads: the size of its text copy, so the import
   * budgets see everything a history-tier read brings across.
   */
  messageBytes: number;
}

export interface T3Snapshot {
  projects: T3Project[];
  threads: T3Thread[];
  /**
   * Projects shaped like T3's scratch project: titled "No project" with a
   * workspace folder named `scratch`. The adapter confirms the folder is the
   * one under the T3 home, which the worker cannot know.
   */
  scratchProjectIds: string[];
  migrationCount: number;
}

/** The turn-item types the history-tier import shows beside the messages. */
export const T3_TURN_ITEM_TYPES = [
  'command_execution',
  'file_change',
  'web_search',
  'error',
] as const;

export type T3TurnItemType = (typeof T3_TURN_ITEM_TYPES)[number];

export interface T3Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  createdAt: string;
  attachmentIds: string[];
}

export interface T3TurnItem {
  id: string;
  type: T3TurnItemType;
  ordinal: number;
  /** The allowlisted payload fields of {@link T3_TURN_ITEM_FIELDS}, strings capped. */
  payload: Record<string, unknown>;
}

export interface T3Attachment {
  /** `<threadId>-<uuid>[-<ext>]`; the file is `<state>/attachments/<id>.<ext>`. */
  id: string;
  name: string | null;
  mimeType: string | null;
}

/** One thread's text copy: what the history-tier import projects. */
export interface T3ThreadTranscript {
  messages: T3Message[];
  items: T3TurnItem[];
  attachments: T3Attachment[];
}

/** What the `threads` request returns, by thread id; unknown ids are absent. */
export type T3ThreadDetails = Record<string, T3ThreadTranscript>;

/**
 * Longest string kept from a turn-item payload. The projection shows 4 KiB of
 * command output; one more character tells it the output went on. File
 * contents (`diffStr`) and other bulky fields are never copied out.
 */
export const T3_TURN_ITEM_STRING_LIMIT = 4096 + 1;
const T3_TURN_ITEM_ARRAY_LIMIT = 100;

/** Payload fields kept per turn-item type; everything else stays in the store. */
const T3_TURN_ITEM_FIELDS: Record<T3TurnItemType, readonly string[]> = {
  command_execution: ['input', 'command', 'output', 'exitCode', 'status'],
  file_change: ['changes', 'fileName', 'title', 'summary'],
  web_search: ['query', 'patterns'],
  error: ['failure', 'message'],
};
const T3_TURN_ITEM_TIME_FIELDS = ['startedAt', 'updatedAt'];

/** Tables and columns the `threads` read selects, checked like the snapshot's. */
const T3_THREAD_TABLES: Record<string, string[]> = {
  orchestration_v2_projection_messages: [
    'message_id',
    'thread_id',
    'role',
    'created_at',
    'payload_json',
  ],
  orchestration_v2_projection_turn_items: [
    'turn_item_id',
    'thread_id',
    'ordinal',
    'type',
    'payload_json',
  ],
};

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function count(value: unknown): number {
  if (typeof value === 'bigint') return Number(value);
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function rows(
  db: DatabaseSync,
  sql: string,
  ...params: string[]
): Record<string, unknown>[] {
  return db
    .prepare(sql)
    .all(...params)
    .filter(isRecord);
}

/** Last path segment of a recorded folder, whichever separator the host wrote. */
function lastSegment(folder: string): string {
  const parts = folder.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

function readMigrationCount(db: DatabaseSync): number | null {
  try {
    const [row] = rows(db, 'select count(*) as n from effect_sql_migrations');
    return row ? count(row.n) : null;
  } catch {
    return null;
  }
}

interface ProviderThreadRow {
  providerThreadId: string;
  driver: string | null;
  nativeId: string | null;
  providerInstanceId: string | null;
  updatedAt: string;
}

function readProviderThreads(
  db: DatabaseSync,
): Map<string, ProviderThreadRow[]> {
  // `json_valid` first: one corrupt payload must not fail the whole read.
  const found = rows(
    db,
    `select provider_thread_id, thread_id, provider, driver, provider_instance_id, updated_at,
       case when json_valid(payload_json) then json_extract(payload_json, '$.nativeThreadRef.nativeId') end as native_id,
       case when json_valid(payload_json) then json_extract(payload_json, '$.nativeThreadRef.driver') end as native_driver
     from orchestration_v2_projection_provider_threads
     where thread_id is not null`,
  );
  const byThread = new Map<string, ProviderThreadRow[]>();
  for (const row of found) {
    const threadId = text(row.thread_id);
    const providerThreadId = text(row.provider_thread_id);
    if (!threadId || !providerThreadId) continue;
    const list = byThread.get(threadId) ?? [];
    list.push({
      providerThreadId,
      // `driver` arrived in a later migration; older rows only have `provider`.
      driver: text(row.driver) ?? text(row.native_driver) ?? text(row.provider),
      nativeId: text(row.native_id)?.trim() || null,
      providerInstanceId: text(row.provider_instance_id),
      updatedAt: text(row.updated_at) ?? '',
    });
    byThread.set(threadId, list);
  }
  return byThread;
}

/**
 * The provider thread that ran a thread now: the one its
 * `active_provider_thread_id` names, else the most recently updated. A
 * handoff leaves several rows per thread, and only the active one holds the
 * session the user last worked in.
 */
function pickProviderThread(
  candidates: ProviderThreadRow[] | undefined,
  activeProviderThreadId: string | null,
): ProviderThreadRow | null {
  if (!candidates || candidates.length === 0) return null;
  const active = candidates.find(
    (candidate) => candidate.providerThreadId === activeProviderThreadId,
  );
  if (active) return active;
  return candidates.reduce((newest, candidate) =>
    Date.parse(candidate.updatedAt) > Date.parse(newest.updatedAt)
      ? candidate
      : newest,
  );
}

/**
 * Reads every live T3 project and thread with the facts discovery needs.
 * Soft-deleted rows (`deleted_at`) are dropped here, so nothing downstream can
 * resurrect a thread the user removed. Throws {@link StoreSchemaError} naming
 * the first missing column and the store's migration count when the layout is
 * not the one this reader was written against.
 */
export function readT3CodeSnapshot(db: DatabaseSync): T3Snapshot {
  const missing = requireTables(db, T3_REQUIRED_TABLES);
  if (missing) {
    const migrations = readMigrationCount(db);
    throw new StoreSchemaError(
      `${missing} (migrations: ${migrations ?? 'unknown'})`,
    );
  }
  const migrationCount = readMigrationCount(db) ?? 0;

  const projects: T3Project[] = [];
  const scratchProjectIds: string[] = [];
  for (const row of rows(
    db,
    `select project_id, title, workspace_root, created_at, updated_at, archived_at
     from projection_projects where deleted_at is null order by project_id`,
  )) {
    const projectId = text(row.project_id);
    const workspaceRoot = text(row.workspace_root);
    if (!projectId || !workspaceRoot) continue;
    const title = text(row.title) ?? '';
    projects.push({
      projectId,
      title,
      workspaceRoot,
      createdAt: text(row.created_at) ?? '',
      updatedAt: text(row.updated_at) ?? '',
      archivedAt: text(row.archived_at),
    });
    if (title === 'No project' && lastSegment(workspaceRoot) === 'scratch') {
      scratchProjectIds.push(projectId);
    }
  }

  const messageBytes = new Map<string, number>();
  for (const row of rows(
    db,
    `select thread_id, sum(bytes) as bytes from (
       select thread_id, length(cast(payload_json as blob)) as bytes
       from orchestration_v2_projection_messages
       union all
       select thread_id, length(cast(payload_json as blob))
       from orchestration_v2_projection_turn_items
       where type in (select value from json_each(?))
     ) group by thread_id`,
    JSON.stringify(T3_TURN_ITEM_TYPES),
  )) {
    const threadId = text(row.thread_id);
    if (threadId) messageBytes.set(threadId, count(row.bytes));
  }

  const providerThreads = readProviderThreads(db);
  const threads: T3Thread[] = [];
  for (const row of rows(
    db,
    `select thread_id, project_id, title, active_provider_thread_id, provider_instance_id,
       created_at, updated_at, archived_at,
       case when json_valid(payload_json) then json_extract(payload_json, '$.worktreePath') end as worktree_path
     from orchestration_v2_projection_threads where deleted_at is null order by thread_id`,
  )) {
    const threadId = text(row.thread_id);
    const projectId = text(row.project_id);
    if (!threadId || !projectId) continue;
    const provider = pickProviderThread(
      providerThreads.get(threadId),
      text(row.active_provider_thread_id),
    );
    threads.push({
      threadId,
      projectId,
      title: text(row.title) ?? '',
      driver: provider?.driver ?? null,
      nativeId: provider?.nativeId ?? null,
      worktreePath: text(row.worktree_path)?.trim() || null,
      providerInstanceId:
        provider?.providerInstanceId ?? text(row.provider_instance_id),
      createdAt: text(row.created_at) ?? '',
      updatedAt: text(row.updated_at) ?? '',
      archivedAt: text(row.archived_at),
      messageBytes: messageBytes.get(threadId) ?? 0,
    });
  }

  return { projects, threads, scratchProjectIds, migrationCount };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Caps strings and arrays so one huge payload cannot balloon the transfer. */
function capped(value: unknown, depth = 0): unknown {
  if (typeof value === 'string')
    return value.slice(0, T3_TURN_ITEM_STRING_LIMIT);
  if (Array.isArray(value))
    return depth > 2
      ? []
      : value
          .slice(0, T3_TURN_ITEM_ARRAY_LIMIT)
          .map((entry) => capped(entry, depth + 1));
  if (isRecord(value)) {
    if (depth > 2) return {};
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        capped(entry, depth + 1),
      ]),
    );
  }
  return value;
}

function turnItemType(value: unknown): T3TurnItemType | null {
  return T3_TURN_ITEM_TYPES.find((type) => type === value) ?? null;
}

function messageRole(value: unknown): T3Message['role'] | null {
  return value === 'user' || value === 'assistant' || value === 'system'
    ? value
    : null;
}

function emptyTranscript(): T3ThreadTranscript {
  return { messages: [], items: [], attachments: [] };
}

/** Attachment refs of one message payload; shapes it does not know are skipped. */
function readAttachments(payload: Record<string, unknown>): T3Attachment[] {
  if (!Array.isArray(payload.attachments)) return [];
  const found: T3Attachment[] = [];
  for (const entry of payload.attachments) {
    if (!isRecord(entry)) continue;
    const id = text(entry.id)?.trim();
    if (!id) continue;
    found.push({
      id,
      name: text(entry.name),
      mimeType: text(entry.mimeType),
    });
  }
  return found;
}

/**
 * Reads the text copy of the selected threads for the history-tier import:
 * their messages (ordered by `created_at`, `message_id`), the four turn-item
 * types the import shows (ordered by `ordinal`) with only their allowlisted
 * payload fields, and the attachment refs the messages carry. Reasoning,
 * checkpoints, plans, approvals, and tool payloads are never selected.
 */
export function readT3CodeThreads(
  db: DatabaseSync,
  threadIds: string[],
): T3ThreadDetails {
  const missing = requireTables(db, T3_THREAD_TABLES);
  if (missing) {
    const migrations = readMigrationCount(db);
    throw new StoreSchemaError(
      `${missing} (migrations: ${migrations ?? 'unknown'})`,
    );
  }
  const wanted = JSON.stringify(Array.from(new Set(threadIds)));
  const details = new Map<string, T3ThreadTranscript>();
  const transcriptOf = (threadId: string): T3ThreadTranscript => {
    let transcript = details.get(threadId);
    if (!transcript) {
      transcript = emptyTranscript();
      details.set(threadId, transcript);
    }
    return transcript;
  };

  for (const row of rows(
    db,
    `select message_id, thread_id, role, created_at, payload_json
     from orchestration_v2_projection_messages
     where thread_id in (select value from json_each(?))
     order by thread_id, created_at, message_id`,
    wanted,
  )) {
    const threadId = text(row.thread_id);
    const id = text(row.message_id);
    const role = messageRole(row.role);
    const payload = parseJson(row.payload_json);
    if (!threadId || !id || !role || !isRecord(payload)) continue;
    const transcript = transcriptOf(threadId);
    const attachments = readAttachments(payload);
    transcript.attachments.push(...attachments);
    transcript.messages.push({
      id,
      role,
      text: text(payload.text) ?? '',
      createdAt: text(row.created_at) ?? '',
      attachmentIds: attachments.map((attachment) => attachment.id),
    });
  }

  for (const row of rows(
    db,
    `select turn_item_id, thread_id, ordinal, type, payload_json
     from orchestration_v2_projection_turn_items
     where thread_id in (select value from json_each(?))
       and type in (select value from json_each(?))
     order by thread_id, ordinal, turn_item_id`,
    wanted,
    JSON.stringify(T3_TURN_ITEM_TYPES),
  )) {
    const threadId = text(row.thread_id);
    const id = text(row.turn_item_id);
    const type = turnItemType(row.type);
    const parsed = parseJson(row.payload_json);
    if (!threadId || !id || !type || !isRecord(parsed)) continue;
    const payload: Record<string, unknown> = {};
    for (const field of [
      ...T3_TURN_ITEM_FIELDS[type],
      ...T3_TURN_ITEM_TIME_FIELDS,
    ]) {
      if (parsed[field] !== undefined) payload[field] = capped(parsed[field]);
    }
    transcriptOf(threadId).items.push({
      id,
      type,
      ordinal: count(row.ordinal),
      payload,
    });
  }

  return Object.fromEntries(details);
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isT3Project(value: unknown): value is T3Project {
  return (
    isRecord(value) &&
    typeof value.projectId === 'string' &&
    typeof value.title === 'string' &&
    typeof value.workspaceRoot === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    isStringOrNull(value.archivedAt)
  );
}

function isT3Thread(value: unknown): value is T3Thread {
  return (
    isRecord(value) &&
    typeof value.threadId === 'string' &&
    typeof value.projectId === 'string' &&
    typeof value.title === 'string' &&
    isStringOrNull(value.driver) &&
    isStringOrNull(value.nativeId) &&
    isStringOrNull(value.worktreePath) &&
    isStringOrNull(value.providerInstanceId) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    isStringOrNull(value.archivedAt) &&
    typeof value.messageBytes === 'number'
  );
}

/** Narrows the worker's untyped `data` to a snapshot before the adapter trusts it. */
export function isT3Snapshot(value: unknown): value is T3Snapshot {
  return (
    isRecord(value) &&
    Array.isArray(value.projects) &&
    value.projects.every(isT3Project) &&
    Array.isArray(value.threads) &&
    value.threads.every(isT3Thread) &&
    Array.isArray(value.scratchProjectIds) &&
    value.scratchProjectIds.every((id) => typeof id === 'string') &&
    typeof value.migrationCount === 'number'
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isT3Message(value: unknown): value is T3Message {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    messageRole(value.role) !== null &&
    typeof value.text === 'string' &&
    typeof value.createdAt === 'string' &&
    isStringArray(value.attachmentIds)
  );
}

function isT3TurnItem(value: unknown): value is T3TurnItem {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    turnItemType(value.type) !== null &&
    typeof value.ordinal === 'number' &&
    isRecord(value.payload)
  );
}

function isT3Attachment(value: unknown): value is T3Attachment {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    isStringOrNull(value.name) &&
    isStringOrNull(value.mimeType)
  );
}

function isT3ThreadTranscript(value: unknown): value is T3ThreadTranscript {
  return (
    isRecord(value) &&
    Array.isArray(value.messages) &&
    value.messages.every(isT3Message) &&
    Array.isArray(value.items) &&
    value.items.every(isT3TurnItem) &&
    Array.isArray(value.attachments) &&
    value.attachments.every(isT3Attachment)
  );
}

/** Narrows the worker's untyped `data` to thread details before the import trusts it. */
export function isT3ThreadDetails(value: unknown): value is T3ThreadDetails {
  return isRecord(value) && Object.values(value).every(isT3ThreadTranscript);
}
