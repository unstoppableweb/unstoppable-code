import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { ExternalProjectProvider } from '@canopy/desktop-shared/types';
import { BRAND } from '@canopy/brand/current';
import { isPathInside } from '../lib/path-safety';
import { isRecord } from '../lib/type-guards';
import {
  claudeProjectDirSlug,
  isClaudeProjectDirUnderRoots,
  readClaudeTranscriptHeadMetadata,
} from './claude-discovery';
import {
  listCodexDayDirectoriesNewestFirst,
  readCodexRolloutHeadMetadata,
} from './codex-discovery';
import {
  createReadPool,
  listFilesNewestFirst,
  parseJsonLinesHead,
  readFileHead,
  type ReadPool,
} from './file-head';
import { collectExcludedRoots, safeRealpath } from './excluded-roots';
import { collectOwnOpenCodeSessionIds } from './own-opencode-sessions';
import {
  resolveClaudeGlobalConfigPath,
  resolveClaudeProjectsDir,
  resolveCodexGlobalStatePath,
  resolveCodexSessionsDir,
  resolveOpenCodeDatabasePath,
  resolveT3CodeDatabasePath,
} from './provider-paths';
import { DEFAULT_DISCOVERY_LIMITS } from './types';

/**
 * Cheap "does this machine hold any Claude, Codex, T3 Code or OpenCode
 * project evidence that did not come from Canopy itself?" probe (CAN-2439). It gates the onboarding
 * step, the Getting started entry, and the one-time invite, so it must stay
 * far cheaper than a scan and must not fire for Canopy's own footprint:
 * every Canopy chat writes a Claude transcript under `~/.claude/projects`
 * and a Codex rollout under `~/.codex/sessions`, so mere existence of those
 * directories proves nothing. Evidence counts only when it points outside the
 * brand data directories (Claude) or carries a foreign originator (Codex).
 * The T3 Code and OpenCode stores are SQLite files, probed with one bounded
 * read-only query each on the live file (no copy, no waiting on a lock, and
 * no file created beside it; see `liveStoreLocation`); see
 * `t3CodeStoreHasThread` and `openCodeStoreHasForeignSession` for how each
 * reads a failure.
 */

const MAX_ROLLOUTS_INSPECTED = 25;
const ROLLOUT_HEAD_BYTES = 16 * 1024;
/** External Claude project directories whose transcripts are inspected. */
const MAX_CLAUDE_DIRS_INSPECTED = 40;
/** Newest transcripts read per directory when looking for a native session. */
const MAX_CLAUDE_TRANSCRIPTS_PER_DIR = 5;
const CLAUDE_HEAD_BYTES = 16 * 1024;

export interface ProviderPresenceOptions {
  claudeProjectsDir?: string;
  claudeGlobalConfigPath?: string;
  codexSessionsDir?: string;
  codexGlobalStatePath?: string;
  /** Canonical directories whose contents are Canopy's own footprint. */
  excludedRoots?: string[];
  /**
   * Further roots that are Canopy's, added to the defaults: the external
   * folders of attached Cowork projects, whose Claude project directories
   * would otherwise read as evidence of provider use.
   */
  extraExcludedRoots?: string[];
  ownOriginators?: readonly string[];
  t3DbPath?: string;
  openCodeDbPath?: string;
  /** Native OpenCode session ids Canopy's own runs created; collected when omitted. */
  ownOpenCodeSessionIds?: ReadonlySet<string>;
}

/** Newest top-level OpenCode sessions inspected for one that is not Canopy's. */
const MAX_OPENCODE_SESSIONS_INSPECTED = 200;

function isOutsideRoots(candidate: string, roots: string[]): boolean {
  return !roots.some((root) => isPathInside(root, candidate));
}

async function claudeProjectsDirHasExternalEntry(
  projectsDir: string,
  roots: string[],
  pool: ReadPool,
): Promise<boolean> {
  let entries: string[];
  try {
    entries = (await readdir(projectsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return false;
  }
  // The same rule the discovery adapter uses to skip its own footprint.
  const slugs = roots.map(claudeProjectDirSlug);
  const external = entries.filter(
    (name) => !isClaudeProjectDirUnderRoots(name, slugs),
  );
  // A directory outside Canopy's roots still proves nothing on its own:
  // Canopy chats in an external folder write there too. Only a transcript a
  // person started themselves (not through the SDK) counts as evidence.
  for (const name of external.slice(0, MAX_CLAUDE_DIRS_INSPECTED)) {
    if (
      await claudeProjectDirHasNativeTranscript(
        path.join(projectsDir, name),
        pool,
      )
    ) {
      return true;
    }
  }
  return false;
}

async function claudeProjectDirHasNativeTranscript(
  directory: string,
  pool: ReadPool,
): Promise<boolean> {
  const files = await listFilesNewestFirst(
    directory,
    (entry) => entry.isFile() && entry.name.endsWith('.jsonl'),
    pool,
  );
  for (const file of files.slice(0, MAX_CLAUDE_TRANSCRIPTS_PER_DIR)) {
    try {
      const head = await readFileHead(file.path, CLAUDE_HEAD_BYTES);
      const metadata = readClaudeTranscriptHeadMetadata(
        parseJsonLinesHead(head, CLAUDE_HEAD_BYTES),
      );
      if (metadata?.native) return true;
    } catch {
      // Unreadable transcript: not evidence either way.
    }
  }
  return false;
}

async function claudeGlobalConfigHasExternalProject(
  filePath: string,
  roots: string[],
): Promise<boolean> {
  try {
    const stats = await stat(filePath);
    if (stats.size > DEFAULT_DISCOVERY_LIMITS.maxGlobalConfigBytes)
      return false;
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (!isRecord(parsed) || !isRecord(parsed.projects)) return false;
    return Object.keys(parsed.projects).some(
      (key) => path.isAbsolute(key) && isOutsideRoots(key, roots),
    );
  } catch {
    return false;
  }
}

async function codexGlobalStateHasProject(
  filePath: string,
  roots: string[],
): Promise<boolean> {
  try {
    const stats = await stat(filePath);
    if (stats.size > DEFAULT_DISCOVERY_LIMITS.maxGlobalConfigBytes)
      return false;
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (!isRecord(parsed) || !isRecord(parsed['local-projects'])) return false;
    return Object.values(parsed['local-projects']).some(
      (project) =>
        isRecord(project) &&
        Array.isArray(project.rootPaths) &&
        project.rootPaths.some(
          (root) =>
            typeof root === 'string' &&
            path.isAbsolute(root) &&
            isOutsideRoots(root, roots),
        ),
    );
  } catch {
    return false;
  }
}

async function codexSessionsHaveForeignThread(
  sessionsDir: string,
  roots: string[],
  ownOriginators: ReadonlySet<string>,
  pool: ReadPool,
): Promise<boolean> {
  let inspected = 0;
  for (const dayDir of await listCodexDayDirectoriesNewestFirst(sessionsDir)) {
    const files = await listFilesNewestFirst(
      dayDir,
      (entry) =>
        entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl'),
      pool,
    );
    for (const file of files) {
      if (inspected >= MAX_ROLLOUTS_INSPECTED) return false;
      inspected += 1;
      let head: string;
      try {
        head = await readFileHead(file.path, ROLLOUT_HEAD_BYTES);
      } catch {
        continue;
      }
      const metadata = readCodexRolloutHeadMetadata(
        parseJsonLinesHead(head, ROLLOUT_HEAD_BYTES),
      );
      if (!metadata) continue;
      if (ownOriginators.has(metadata.originator)) continue;
      if (isOutsideRoots(metadata.cwd, roots)) return true;
    }
  }
  return false;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/**
 * How the probe opens a live store without creating anything beside it. A
 * plain read-only open of a WAL database creates `-shm` and `-wal` files when
 * they are missing and leaves them after closing, which would write into the
 * tool's data folder. When both already exist (the tool is running), that open
 * adds nothing and sees its newest writes. Otherwise the file is opened as
 * immutable: SQLite then takes no locks and creates no files, and no running
 * writer's newest state is missed (a `-wal` left by an unclean exit is
 * ignored, so its last writes can be).
 */
function liveStoreLocation(dbPath: string): string | URL {
  if (existsSync(`${dbPath}-wal`) && existsSync(`${dbPath}-shm`)) {
    return dbPath;
  }
  const location = pathToFileURL(dbPath);
  location.search = 'mode=ro&immutable=1';
  return location;
}

/**
 * Opens a store read-only on the live file and fails fast on a lock: the
 * owning app is usually running, and the probe must never queue behind it.
 */
function withLiveStore<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(liveStoreLocation(dbPath), { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 0');
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * A T3 Code store counts when it holds one live thread of a real project (the
 * scratch "No project" bucket is what a fresh install accumulates). A file
 * that exists but cannot be queried (locked, corrupt, a newer schema) still
 * counts: it is strong evidence of T3 Code use, and the cost of a false
 * positive is only an invite the scan then resolves to nothing.
 */
async function t3CodeStoreHasThread(dbPath: string): Promise<boolean> {
  if (!(await fileExists(dbPath))) return false;
  try {
    return withLiveStore(
      dbPath,
      (db) =>
        db
          .prepare(
            `SELECT 1 FROM orchestration_v2_projection_threads t
             JOIN projection_projects p USING (project_id)
             WHERE t.deleted_at IS NULL AND p.deleted_at IS NULL
               AND p.title <> 'No project' LIMIT 1`,
          )
          .get() !== undefined,
    );
  } catch {
    return true;
  }
}

/**
 * OpenCode keeps no origin on a session, so Canopy's own runs show up in its
 * database. A store counts only when one of the newest top-level sessions is
 * neither a session Canopy bound nor in a Canopy directory (the same test the
 * discovery adapter applies). A failure counts as absent: the common false
 * positive here is Canopy's own OpenCode use, which must never raise an invite.
 */
async function openCodeStoreHasForeignSession(
  dbPath: string,
  roots: string[],
  ownSessionIds: ReadonlySet<string> | undefined,
): Promise<boolean> {
  if (!(await fileExists(dbPath))) return false;
  try {
    // Scans every data root the brand owns, up to the binding-file cap. A
    // truncated set is safe here: it can only leave one of Canopy's own
    // sessions looking foreign, so it can raise an invite the scan then
    // resolves to nothing, and can never hide a user's session.
    const own = ownSessionIds ?? (await collectOwnOpenCodeSessionIds());
    const rows = withLiveStore(dbPath, (db) =>
      db
        .prepare(
          `SELECT id, directory FROM session_v2 WHERE parent_id IS NULL
           ORDER BY time_updated DESC LIMIT ?`,
        )
        .all(MAX_OPENCODE_SESSIONS_INSPECTED),
    );
    return rows.some(
      (row) =>
        typeof row.id === 'string' &&
        typeof row.directory === 'string' &&
        !own.has(row.id) &&
        isOutsideRoots(row.directory, roots),
    );
  } catch {
    return false;
  }
}

export async function detectProviderStorePresenceByProvider(
  options: ProviderPresenceOptions = {},
): Promise<Record<ExternalProjectProvider, boolean>> {
  const roots = [...(options.excludedRoots ?? (await collectExcludedRoots()))];
  for (const extra of options.extraExcludedRoots ?? []) {
    roots.push(await safeRealpath(extra), path.resolve(extra));
  }
  const ownOriginators = new Set(
    options.ownOriginators ?? [BRAND.id, 'canopy'],
  );
  // One read pool for the whole probe, the same bound a scan uses, so the
  // directory listings below can never fan out past it.
  const pool = createReadPool(DEFAULT_DISCOVERY_LIMITS.maxConcurrentReads);
  // The four providers are probed concurrently. Within a provider the signals
  // run cheapest first and stop at the first hit. Claude: the projects
  // directory listing with a bounded number of 16 KiB transcript heads, then
  // the potentially large `~/.claude.json` parse. Codex: the small desktop
  // registry, then rollout heads.
  const claudePresent = async (): Promise<boolean> =>
    (await claudeProjectsDirHasExternalEntry(
      options.claudeProjectsDir ?? resolveClaudeProjectsDir(),
      roots,
      pool,
    )) ||
    (await claudeGlobalConfigHasExternalProject(
      options.claudeGlobalConfigPath ?? resolveClaudeGlobalConfigPath(),
      roots,
    ));
  const codexPresent = async (): Promise<boolean> =>
    (await codexGlobalStateHasProject(
      options.codexGlobalStatePath ?? resolveCodexGlobalStatePath(),
      roots,
    )) ||
    (await codexSessionsHaveForeignThread(
      options.codexSessionsDir ?? resolveCodexSessionsDir(),
      roots,
      ownOriginators,
      pool,
    ));
  const [claude, codex, t3code, opencode] = await Promise.all([
    claudePresent(),
    codexPresent(),
    t3CodeStoreHasThread(options.t3DbPath ?? resolveT3CodeDatabasePath()),
    openCodeStoreHasForeignSession(
      options.openCodeDbPath ?? resolveOpenCodeDatabasePath(),
      roots,
      options.ownOpenCodeSessionIds,
    ),
  ]);
  return { claude, codex, t3code, opencode };
}

export async function detectProviderStorePresence(
  options: ProviderPresenceOptions = {},
): Promise<boolean> {
  return Object.values(
    await detectProviderStorePresenceByProvider(options),
  ).some(Boolean);
}
