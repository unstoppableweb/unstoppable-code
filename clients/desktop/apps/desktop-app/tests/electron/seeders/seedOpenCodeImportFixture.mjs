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
 * Seeds an OpenCode store for the project import flow under the harness's
 * isolated provider state: `XDG_DATA_HOME` is
 * `<userDataDir>/provider-state/xdg` (see `env` in the result), so the store
 * is `<that>/opencode/opencode.db`.
 *
 * The database is a real `opencode.db` built from OpenCode 2.0.32's own DDL,
 * the tables the import reads, as the main-process fixture helper
 * (`src/main/__tests__/helpers/external-store-fixtures.ts`) builds it. One
 * plain folder (`oc-field-notes`, a Cowork project) holds two top-level
 * sessions, `Plan the migration` and `Fix the flaky test`. OpenCode sessions
 * import as read-only history.
 *
 * The folder lives under the OS temp dir, which production discovery
 * excludes; `CANOPY_E2E_ALLOW_TEMP_PROJECT_IMPORT` in `env` lifts that.
 * Call the returned `cleanup()` in the spec's `finally`.
 */

export const OPENCODE_FIXTURE_PROJECT = 'oc-field-notes';
export const OPENCODE_FIXTURE_TITLES = [
  'Fix the flaky test',
  'Plan the migration',
];

/** DDL captured verbatim from OpenCode 2.0.32; only the tables the import reads. */
const OPENCODE_DDL = [
  'CREATE TABLE `project` (`id` text PRIMARY KEY, `worktree` text NOT NULL, `vcs` text, `name` text, `icon_url` text, `icon_url_override` text, `icon_color` text, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `time_initialized` integer, `time_active` integer DEFAULT 0 NOT NULL, `time_archived` integer, `sandboxes` text NOT NULL, `commands` text)',
  'CREATE TABLE `worktree` (`project_id` text NOT NULL, `directory` text NOT NULL, `strategy` text, `time_created` integer NOT NULL, CONSTRAINT `worktree_pk` PRIMARY KEY(`project_id`, `directory`), CONSTRAINT `fk_worktree_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE)',
  'CREATE TABLE `session_v2` (`id` text PRIMARY KEY, `project_id` text NOT NULL, `workspace_id` text, `parent_id` text, `fork_session_id` text, `fork_boundary` text, `slug` text NOT NULL, `directory` text NOT NULL, `path` text, `title` text, `version` text NOT NULL, `share_url` text, `summary_additions` integer, `summary_deletions` integer, `summary_files` integer, `summary_diffs` text, `metadata` text, `cost` real DEFAULT 0 NOT NULL, `tokens_input` integer DEFAULT 0 NOT NULL, `tokens_output` integer DEFAULT 0 NOT NULL, `tokens_reasoning` integer DEFAULT 0 NOT NULL, `tokens_cache_read` integer DEFAULT 0 NOT NULL, `tokens_cache_write` integer DEFAULT 0 NOT NULL, `revert` text, `permission` text, `agent` text, `model` text, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `time_idle` integer, `time_viewed` integer, `idle_outcome` text, `time_compacting` integer, `time_archived` integer, `time_suspended` integer, `resume_attempts` integer DEFAULT 0 NOT NULL, CONSTRAINT `fk_session_v2_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE)',
  'CREATE TABLE `session_message` (`id` text PRIMARY KEY, `session_id` text NOT NULL, `type` text NOT NULL, `seq` integer NOT NULL, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `data` text NOT NULL, CONSTRAINT `fk_session_message_session_id_session_v2_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session_v2`(`id`) ON DELETE CASCADE)',
  'CREATE TABLE "migration" (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)',
];

const SESSIONS = [
  {
    id: 'ses_fix',
    title: 'Fix the flaky test',
    updatedAt: '2026-11-06T10:00:00.000Z',
    prompt: 'Why does the upload test fail on CI?',
  },
  {
    id: 'ses_plan',
    title: 'Plan the migration',
    updatedAt: '2026-11-05T10:00:00.000Z',
    prompt: 'Plan the database migration',
  },
];

function buildOpenCodeDatabase(dbPath, worktree) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('pragma journal_mode = wal');
    for (const statement of OPENCODE_DDL) db.exec(statement);
    const migration = db.prepare(
      'insert into migration (id, time_completed) values (?, 1794000000000)',
    );
    for (const id of [
      '20260101000000_init',
      '20260301120000_sessions',
      '20260604172448_event_sourced_session_input',
    ])
      migration.run(id);
    db.prepare(
      `insert into project
       (id, worktree, vcs, name, time_created, time_updated, time_active, sandboxes)
       values ('proj-notes', ?, null, null, 1794000000000, 1794000000000, 0, '[]')`,
    ).run(worktree);
    db.prepare(
      `insert into worktree (project_id, directory, strategy, time_created)
       values ('proj-notes', ?, null, 1794000000000)`,
    ).run(worktree);
    const session = db.prepare(
      `insert into session_v2
       (id, project_id, slug, directory, title, version, time_created, time_updated)
       values (?, 'proj-notes', 'slug', ?, ?, '2.0.32', ?, ?)`,
    );
    const message = db.prepare(
      `insert into session_message (id, session_id, type, seq, time_created, time_updated, data)
       values (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of SESSIONS) {
      const updated = Date.parse(s.updatedAt);
      session.run(s.id, worktree, s.title, updated - 120_000, updated);
      message.run(
        `${s.id}_u1`,
        s.id,
        'user',
        0,
        updated - 60_000,
        updated - 60_000,
        JSON.stringify({ text: s.prompt }),
      );
      message.run(
        `${s.id}_a1`,
        s.id,
        'assistant',
        1,
        updated - 55_000,
        updated - 55_000,
        JSON.stringify({
          content: [{ type: 'text', text: `Looked into it: ${s.prompt}` }],
        }),
      );
    }
  } finally {
    db.close();
  }
}

/**
 * @param {object} options
 * @param {string} options.userDataDir
 */
export function seedOpenCodeImportFixture({ userDataDir }) {
  const fixturesRoot = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'opencode-fixtures-')),
  );
  const projectDir = path.join(fixturesRoot, OPENCODE_FIXTURE_PROJECT);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(path.join(projectDir, 'notes.md'), '# Field notes\n');

  const xdgDataHome = path.join(userDataDir, 'provider-state', 'xdg');
  buildOpenCodeDatabase(
    path.join(xdgDataHome, 'opencode', 'opencode.db'),
    projectDir,
  );

  return {
    fixturesRoot,
    projectDir,
    env: {
      CANOPY_E2E_ALLOW_TEMP_PROJECT_IMPORT: '1',
      XDG_DATA_HOME: xdgDataHome,
    },
    cleanup: () => rmSync(fixturesRoot, { recursive: true, force: true }),
  };
}
