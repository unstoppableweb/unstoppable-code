import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Seeds a T3 Code store for the project import flow under the harness's
 * isolated provider state: `T3CODE_HOME` is `<userDataDir>/provider-state/t3`
 * (see `env` in the result), and the Codex rollout one thread is backed by
 * sits in the isolated `CODEX_HOME` (`<userDataDir>/provider-state/codex`).
 *
 * The database is a real `statev2.sqlite` built from T3 Code 0.1.7's own DDL,
 * the tables the import reads, as the main-process fixture helper
 * (`src/main/__tests__/helpers/external-store-fixtures.ts`) builds it. One
 * plain folder (`t3-review-app`, a Cowork project) holds three threads:
 *
 * - `Review the pull request`: run on Codex, backed by a rollout, so it
 *   imports as a chat that can continue;
 * - `Sketch the layout`: run on Grok, which Canopy cannot read, so it imports
 *   from T3's own text copy as read-only history with no provider;
 * - `Plan the release`: the same, archived in T3.
 *
 * The folder lives under the OS temp dir, which production discovery
 * excludes; `CANOPY_E2E_ALLOW_TEMP_PROJECT_IMPORT` in `env` lifts that.
 * Call the returned `cleanup()` in the spec's `finally`.
 */

export const T3_FIXTURE_PROJECT = 't3-review-app';
export const T3_FIXTURE_CODEX_ID = '01a16b49-4d4b-7460-aee8-869cae2029a5';
export const T3_FIXTURE_CODEX_TITLE = 'Review the pull request';
export const T3_FIXTURE_HISTORY_TITLE = 'Sketch the layout';
export const T3_FIXTURE_ARCHIVED_TITLE = 'Plan the release';

/** DDL captured verbatim from T3 Code 0.1.7; only the tables the import reads. */
const T3_DDL = [
  `CREATE TABLE "effect_sql_migrations" (migration_id integer PRIMARY KEY NOT NULL, created_at datetime NOT NULL DEFAULT current_timestamp, name VARCHAR(255) NOT NULL)`,
  `CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_root TEXT NOT NULL, scripts_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, default_model_selection_json TEXT, default_thread_env_mode TEXT, favicon_path TEXT, auto_pull INTEGER NOT NULL DEFAULT 0, project_icon_json TEXT, pinned_at TEXT, archived_at TEXT)`,
  `CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, default_provider TEXT NOT NULL, runtime_mode TEXT NOT NULL, interaction_mode TEXT NOT NULL, active_provider_thread_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT, deleted_at TEXT, payload_json TEXT NOT NULL, provider_instance_id TEXT)`,
  `CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, owner_node_id TEXT, provider TEXT NOT NULL, provider_session_id TEXT, status TEXT NOT NULL, first_run_ordinal INTEGER, last_run_ordinal INTEGER, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL, driver TEXT, provider_instance_id TEXT)`,
  `CREATE TABLE orchestration_v2_projection_messages (message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT, node_id TEXT, role TEXT NOT NULL, streaming INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL)`,
  `CREATE TABLE orchestration_v2_projection_turn_items (turn_item_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT, node_id TEXT, provider_thread_id TEXT, provider_turn_id TEXT, parent_item_id TEXT, ordinal INTEGER NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL)`,
];

const THREADS = [
  {
    threadId: 'thread-codex',
    title: T3_FIXTURE_CODEX_TITLE,
    driver: 'codex',
    nativeId: T3_FIXTURE_CODEX_ID,
    updatedAt: '2026-11-03T10:00:00.000Z',
    archivedAt: null,
    prompt: 'Review the pull request',
  },
  {
    threadId: 'thread-grok',
    title: T3_FIXTURE_HISTORY_TITLE,
    driver: 'grok',
    nativeId: 'grok-session-1',
    updatedAt: '2026-11-04T10:00:00.000Z',
    archivedAt: null,
    prompt: 'Sketch the settings layout',
  },
  {
    threadId: 'thread-archived',
    title: T3_FIXTURE_ARCHIVED_TITLE,
    driver: 'grok',
    nativeId: 'grok-session-2',
    updatedAt: '2026-11-02T10:00:00.000Z',
    archivedAt: '2026-11-05T10:00:00.000Z',
    prompt: 'Plan the release checklist',
  },
];

function buildT3Database(dbPath, workspaceRoot) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('pragma journal_mode = wal');
    for (const statement of T3_DDL) db.exec(statement);
    const migration = db.prepare(
      'insert into effect_sql_migrations (migration_id, name) values (?, ?)',
    );
    for (let id = 1; id <= 79; id += 1) migration.run(id, `migration-${id}`);
    db.prepare(
      `insert into projection_projects
       (project_id, title, workspace_root, scripts_json, created_at, updated_at)
       values ('p-review', ?, ?, '[]', '2026-11-01T09:00:00.000Z', '2026-11-01T09:00:00.000Z')`,
    ).run(T3_FIXTURE_PROJECT, workspaceRoot);
    const thread = db.prepare(
      `insert into orchestration_v2_projection_threads
       (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        active_provider_thread_id, created_at, updated_at, archived_at, payload_json)
       values (?, 'p-review', ?, 'codex', 'full-access', 'default', ?, '2026-11-01T10:00:00.000Z', ?, ?, ?)`,
    );
    const providerThread = db.prepare(
      `insert into orchestration_v2_projection_provider_threads
       (provider_thread_id, thread_id, provider, provider_session_id, status, updated_at, payload_json, driver)
       values (?, ?, ?, 'session', 'idle', ?, ?, ?)`,
    );
    const message = db.prepare(
      `insert into orchestration_v2_projection_messages
       (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
       values (?, ?, ?, 0, ?, ?, ?)`,
    );
    for (const t of THREADS) {
      const providerThreadId = `${t.threadId}:pt`;
      thread.run(
        t.threadId,
        t.title,
        providerThreadId,
        t.updatedAt,
        t.archivedAt,
        JSON.stringify({ worktreePath: null, title: t.title }),
      );
      providerThread.run(
        providerThreadId,
        t.threadId,
        t.driver,
        t.updatedAt,
        JSON.stringify({
          nativeThreadRef: {
            driver: t.driver,
            nativeId: t.nativeId,
            strength: 'strong',
          },
        }),
        t.driver,
      );
      // T3's own text copy: what a thread without a readable record imports.
      const asked = Date.parse(t.updatedAt) - 60_000;
      message.run(
        `${t.threadId}-u1`,
        t.threadId,
        'user',
        new Date(asked).toISOString(),
        new Date(asked).toISOString(),
        JSON.stringify({ text: t.prompt, attachments: [] }),
      );
      message.run(
        `${t.threadId}-a1`,
        t.threadId,
        'assistant',
        new Date(asked + 5_000).toISOString(),
        new Date(asked + 5_000).toISOString(),
        JSON.stringify({ text: `Done: ${t.prompt}.`, attachments: [] }),
      );
    }
  } finally {
    db.close();
  }
}

function writeCodexRollout(codexHome, cwd) {
  const file = path.join(
    codexHome,
    'sessions',
    '2026',
    '11',
    '03',
    `rollout-2026-11-03T09-59-00-${T3_FIXTURE_CODEX_ID}.jsonl`,
  );
  mkdirSync(path.dirname(file), { recursive: true });
  const at = (seconds) =>
    new Date(
      Date.parse('2026-11-03T09:59:00.000Z') + seconds * 1000,
    ).toISOString();
  const records = [
    {
      timestamp: at(0),
      type: 'session_meta',
      payload: {
        id: T3_FIXTURE_CODEX_ID,
        timestamp: at(0),
        cwd,
        originator: 'codex_cli_rs',
      },
    },
    {
      timestamp: at(5),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Review the pull request' }],
      },
    },
    {
      timestamp: at(10),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Reviewed. Two nits.' }],
      },
    },
  ];
  writeFileSync(
    file,
    records.map((record) => JSON.stringify(record)).join('\n') + '\n',
  );
}

/**
 * @param {object} options
 * @param {string} options.userDataDir
 */
export function seedT3CodeImportFixture({ userDataDir }) {
  const fixturesRoot = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 't3code-fixtures-')),
  );
  const projectDir = path.join(fixturesRoot, T3_FIXTURE_PROJECT);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(path.join(projectDir, 'notes.md'), '# Review notes\n');

  const t3Home = path.join(userDataDir, 'provider-state', 't3');
  buildT3Database(path.join(t3Home, 'userdata', 'statev2.sqlite'), projectDir);
  writeCodexRollout(
    path.join(userDataDir, 'provider-state', 'codex'),
    projectDir,
  );

  return {
    fixturesRoot,
    projectDir,
    t3Home,
    env: {
      CANOPY_E2E_ALLOW_TEMP_PROJECT_IMPORT: '1',
      T3CODE_HOME: t3Home,
    },
    cleanup: () => rmSync(fixturesRoot, { recursive: true, force: true }),
  };
}
