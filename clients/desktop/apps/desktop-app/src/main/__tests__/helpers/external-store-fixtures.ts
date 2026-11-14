import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildSync } from 'esbuild';

// Real T3 Code and OpenCode SQLite stores for the external project import
// tests, built with each tool's own DDL, plus the store read worker bundled the
// way the desktop bundles it (Jest has no built worker to launch). No Jest
// globals, so a node:test caller can reuse it.

/** Bundles `store-read-worker.ts` into `dir` and returns the entry to hand `StoreReadRunner`. */
export function buildStoreReadWorker(dir: string): string {
  const outfile = join(dir, 'external-projects-store-read-worker.js');
  buildSync({
    entryPoints: [
      resolve(__dirname, '../../external-projects/store-read-worker.ts'),
    ],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['node:*'],
    logLevel: 'error',
  });
  return outfile;
}

/** DDL captured verbatim from T3 Code 0.1.7. */
const T3_DDL = [
  `CREATE TABLE "effect_sql_migrations" (migration_id integer PRIMARY KEY NOT NULL, created_at datetime NOT NULL DEFAULT current_timestamp, name VARCHAR(255) NOT NULL)`,
  `CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_root TEXT NOT NULL, scripts_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, default_model_selection_json TEXT, default_thread_env_mode TEXT, favicon_path TEXT, auto_pull INTEGER NOT NULL DEFAULT 0, project_icon_json TEXT, pinned_at TEXT, archived_at TEXT)`,
  `CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, default_provider TEXT NOT NULL, runtime_mode TEXT NOT NULL, interaction_mode TEXT NOT NULL, active_provider_thread_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT, deleted_at TEXT, payload_json TEXT NOT NULL, provider_instance_id TEXT)`,
  `CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, owner_node_id TEXT, provider TEXT NOT NULL, provider_session_id TEXT, status TEXT NOT NULL, first_run_ordinal INTEGER, last_run_ordinal INTEGER, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL, driver TEXT, provider_instance_id TEXT)`,
  `CREATE TABLE orchestration_v2_projection_messages (message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT, node_id TEXT, role TEXT NOT NULL, streaming INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL)`,
  `CREATE TABLE orchestration_v2_projection_turn_items (turn_item_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT, node_id TEXT, provider_thread_id TEXT, provider_turn_id TEXT, parent_item_id TEXT, ordinal INTEGER NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL)`,
];
export interface T3FixtureProject {
  projectId: string;
  title: string;
  workspaceRoot: string;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
  archivedAt?: string | null;
}

export interface T3FixtureProviderThread {
  providerThreadId: string;
  driver: string | null;
  nativeId: string | null;
  providerInstanceId?: string | null;
  updatedAt?: string;
}

export interface T3FixtureThread {
  threadId: string;
  projectId: string;
  title: string;
  worktreePath?: string | null;
  providerInstanceId?: string | null;
  activeProviderThreadId?: string | null;
  providerThreads?: T3FixtureProviderThread[];
  createdAt?: string;
  updatedAt?: string;
  archivedAt?: string | null;
  deletedAt?: string | null;
  /**
   * Message payload_json strings; their summed length is the thread's
   * `messageBytes`. A thread given none of `messages`, `messageRows`, or
   * `turnItems` gets one user message holding its title, since discovery
   * lists only threads with something to import; pass `messageRows: []` for
   * an empty one.
   */
  messages?: string[];
  /** Messages with their own role and time, added after `messages`. */
  messageRows?: T3FixtureMessage[];
  turnItems?: T3FixtureTurnItem[];
}

export interface T3FixtureMessage {
  messageId: string;
  role: 'user' | 'assistant' | 'system';
  createdAt: string;
  /** Decoded `payload_json`; stored as JSON. */
  payload: Record<string, unknown>;
}

export interface T3FixtureTurnItem {
  turnItemId: string;
  ordinal: number;
  type: string;
  status?: string;
  /** Decoded `payload_json`; stored as JSON. */
  payload: Record<string, unknown>;
}

export interface T3FixtureOptions {
  projects: T3FixtureProject[];
  threads: T3FixtureThread[];
  migrations?: number;
}

/** Builds a real `statev2.sqlite` (WAL, like the live store) from T3 Code's own DDL. */
export function buildT3Fixture(
  dbPath: string,
  options: T3FixtureOptions,
): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('pragma journal_mode = wal');
    for (const statement of T3_DDL) db.exec(statement);
    const migration = db.prepare(
      'insert into effect_sql_migrations (migration_id, name) values (?, ?)',
    );
    for (let id = 1; id <= (options.migrations ?? 79); id += 1) {
      migration.run(id, `migration-${id}`);
    }
    const project = db.prepare(
      `insert into projection_projects
       (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at, archived_at)
       values (?, ?, ?, '[]', ?, ?, ?, ?)`,
    );
    for (const p of options.projects) {
      project.run(
        p.projectId,
        p.title,
        p.workspaceRoot,
        p.createdAt ?? '2026-10-24T00:51:48.402Z',
        p.updatedAt ?? '2026-10-24T00:51:48.402Z',
        p.deletedAt ?? null,
        p.archivedAt ?? null,
      );
    }
    const thread = db.prepare(
      `insert into orchestration_v2_projection_threads
       (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json, provider_instance_id)
       values (?, ?, ?, 'codex', 'full-access', 'default', ?, ?, ?, ?, ?, ?, ?)`,
    );
    const providerThread = db.prepare(
      `insert into orchestration_v2_projection_provider_threads
       (provider_thread_id, thread_id, provider, provider_session_id, status, updated_at, payload_json, driver, provider_instance_id)
       values (?, ?, ?, 'session', 'idle', ?, ?, ?, ?)`,
    );
    const message = db.prepare(
      `insert into orchestration_v2_projection_messages
       (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
       values (?, ?, 'user', 0, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', ?)`,
    );
    const messageRow = db.prepare(
      `insert into orchestration_v2_projection_messages
       (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
       values (?, ?, ?, 0, ?, ?, ?)`,
    );
    const turnItem = db.prepare(
      `insert into orchestration_v2_projection_turn_items
       (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
       values (?, ?, ?, ?, ?, '2026-11-01T00:00:00.000Z', ?)`,
    );
    for (const t of options.threads) {
      thread.run(
        t.threadId,
        t.projectId,
        t.title,
        t.activeProviderThreadId
          ? `${t.threadId}:${t.activeProviderThreadId}`
          : null,
        t.createdAt ?? '2026-11-01T10:00:00.000Z',
        t.updatedAt ?? '2026-11-02T10:00:00.000Z',
        t.archivedAt ?? null,
        t.deletedAt ?? null,
        JSON.stringify({
          worktreePath: t.worktreePath ?? null,
          title: t.title,
        }),
        t.providerInstanceId ?? null,
      );
      for (const pt of t.providerThreads ?? []) {
        providerThread.run(
          `${t.threadId}:${pt.providerThreadId}`,
          t.threadId,
          pt.driver ?? 'codex',
          pt.updatedAt ?? '2026-11-01T10:00:00.000Z',
          JSON.stringify({
            nativeThreadRef:
              pt.nativeId === null
                ? null
                : {
                    driver: pt.driver,
                    nativeId: pt.nativeId,
                    strength: 'strong',
                  },
          }),
          pt.driver,
          pt.providerInstanceId ?? null,
        );
      }
      const messages =
        t.messages ??
        (t.messageRows === undefined && t.turnItems === undefined
          ? [JSON.stringify({ text: t.title, attachments: [] })]
          : []);
      messages.forEach((payload, index) =>
        message.run(`${t.threadId}-m${index}`, t.threadId, payload),
      );
      for (const row of t.messageRows ?? []) {
        messageRow.run(
          row.messageId,
          t.threadId,
          row.role,
          row.createdAt,
          row.createdAt,
          JSON.stringify(row.payload),
        );
      }
      for (const item of t.turnItems ?? []) {
        turnItem.run(
          item.turnItemId,
          t.threadId,
          item.ordinal,
          item.type,
          item.status ?? 'completed',
          JSON.stringify(item.payload),
        );
      }
    }
  } finally {
    db.close();
  }
}

/** DDL captured verbatim from OpenCode 2.0.32; only the tables the import reads. */
const OPENCODE_DDL = [
  'CREATE TABLE `project` (`id` text PRIMARY KEY, `worktree` text NOT NULL, `vcs` text, `name` text, `icon_url` text, `icon_url_override` text, `icon_color` text, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `time_initialized` integer, `time_active` integer DEFAULT 0 NOT NULL, `time_archived` integer, `sandboxes` text NOT NULL, `commands` text)',
  'CREATE TABLE `worktree` (`project_id` text NOT NULL, `directory` text NOT NULL, `strategy` text, `time_created` integer NOT NULL, CONSTRAINT `worktree_pk` PRIMARY KEY(`project_id`, `directory`), CONSTRAINT `fk_worktree_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE)',
  'CREATE TABLE `session_v2` (`id` text PRIMARY KEY, `project_id` text NOT NULL, `workspace_id` text, `parent_id` text, `fork_session_id` text, `fork_boundary` text, `slug` text NOT NULL, `directory` text NOT NULL, `path` text, `title` text, `version` text NOT NULL, `share_url` text, `summary_additions` integer, `summary_deletions` integer, `summary_files` integer, `summary_diffs` text, `metadata` text, `cost` real DEFAULT 0 NOT NULL, `tokens_input` integer DEFAULT 0 NOT NULL, `tokens_output` integer DEFAULT 0 NOT NULL, `tokens_reasoning` integer DEFAULT 0 NOT NULL, `tokens_cache_read` integer DEFAULT 0 NOT NULL, `tokens_cache_write` integer DEFAULT 0 NOT NULL, `revert` text, `permission` text, `agent` text, `model` text, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `time_idle` integer, `time_viewed` integer, `idle_outcome` text, `time_compacting` integer, `time_archived` integer, `time_suspended` integer, `resume_attempts` integer DEFAULT 0 NOT NULL, CONSTRAINT `fk_session_v2_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE)',
  'CREATE TABLE `session_message` (`id` text PRIMARY KEY, `session_id` text NOT NULL, `type` text NOT NULL, `seq` integer NOT NULL, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `data` text NOT NULL, CONSTRAINT `fk_session_message_session_id_session_v2_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session_v2`(`id`) ON DELETE CASCADE)',
  'CREATE TABLE "migration" (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)',
  // A table the import must never read; the fixture plants a secret in it.
  'CREATE TABLE `credential` (`id` text PRIMARY KEY, `token` text NOT NULL)',
];
export interface OpenCodeFixtureProject {
  id: string;
  worktree: string;
  vcs?: string | null;
  name?: string | null;
  timeActive?: number;
  timeArchived?: number | null;
  /** `worktree.directory` rows; the main checkout is usually among them. */
  directories?: string[];
}

export interface OpenCodeFixtureSession {
  id: string;
  projectId: string;
  directory: string;
  title?: string | null;
  parentId?: string | null;
  /** Stored verbatim in `model` (a JSON string in a real store). */
  model?: string | null;
  timeCreated?: number;
  timeUpdated?: number;
  timeArchived?: number | null;
  /**
   * `session_message.data` strings; their summed length is the session's
   * `messageBytes`. A session given neither `messages` nor `messageRows` gets
   * one user message, since discovery lists only sessions with messages; pass
   * `messageRows: []` for an empty one.
   */
  messages?: string[];
  /** Messages with their own type, order, and time, added after `messages`. */
  messageRows?: OpenCodeFixtureMessage[];
}

export interface OpenCodeFixtureMessage {
  id: string;
  type: string;
  seq: number;
  timeCreated?: number;
  /** Decoded `data`; stored as JSON. */
  data: Record<string, unknown>;
}

export interface OpenCodeFixtureOptions {
  projects: OpenCodeFixtureProject[];
  sessions: OpenCodeFixtureSession[];
  migrations?: string[];
}

export const OPENCODE_NEWEST_MIGRATION =
  '20260604172448_event_sourced_session_input';

/** Builds a real `opencode.db` (WAL, like the live store) from OpenCode's own DDL. */
export function buildOpenCodeFixture(
  dbPath: string,
  options: OpenCodeFixtureOptions,
): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('pragma journal_mode = wal');
    for (const statement of OPENCODE_DDL) db.exec(statement);
    db.prepare(
      "insert into credential (id, token) values ('c1', 'SECRET-TOKEN')",
    ).run();
    const migration = db.prepare(
      'insert into migration (id, time_completed) values (?, 1794000000000)',
    );
    for (const id of options.migrations ?? [
      '20260101000000_init',
      '20260301120000_sessions',
      OPENCODE_NEWEST_MIGRATION,
    ]) {
      migration.run(id);
    }
    const project = db.prepare(
      `insert into project
       (id, worktree, vcs, name, time_created, time_updated, time_active, time_archived, sandboxes)
       values (?, ?, ?, ?, 1794247834391, 1794247834391, ?, ?, '[]')`,
    );
    const worktree = db.prepare(
      'insert into worktree (project_id, directory, strategy, time_created) values (?, ?, null, 1794247834395)',
    );
    for (const p of options.projects) {
      project.run(
        p.id,
        p.worktree,
        p.vcs === undefined ? 'git' : p.vcs,
        p.name ?? null,
        p.timeActive ?? 0,
        p.timeArchived ?? null,
      );
      for (const directory of p.directories ?? [p.worktree]) {
        worktree.run(p.id, directory);
      }
    }
    const session = db.prepare(
      `insert into session_v2
       (id, project_id, parent_id, slug, directory, title, version, model, time_created, time_updated, time_archived)
       values (?, ?, ?, 'slug', ?, ?, '2.0.32', ?, ?, ?, ?)`,
    );
    const message = db.prepare(
      `insert into session_message (id, session_id, type, seq, time_created, time_updated, data)
       values (?, ?, 'user', ?, 1794248430129, 1794248430129, ?)`,
    );
    const messageRow = db.prepare(
      `insert into session_message (id, session_id, type, seq, time_created, time_updated, data)
       values (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of options.sessions) {
      session.run(
        s.id,
        s.projectId,
        s.parentId ?? null,
        s.directory,
        s.title === undefined ? 'A session' : s.title,
        s.model ?? null,
        s.timeCreated ?? 1794248430129,
        s.timeUpdated ?? 1794426247750,
        s.timeArchived ?? null,
      );
      const messages =
        s.messages ??
        (s.messageRows === undefined
          ? [JSON.stringify({ text: s.title ?? 'A session' })]
          : []);
      messages.forEach((data, index) =>
        message.run(`msg_${s.id}_${index}`, s.id, index, data),
      );
      for (const row of s.messageRows ?? []) {
        const time = row.timeCreated ?? 1794248430129;
        messageRow.run(
          row.id,
          s.id,
          row.type,
          row.seq,
          time,
          time,
          JSON.stringify(row.data),
        );
      }
    }
  } finally {
    db.close();
  }
}
