import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { mapWithConcurrency, normalizeLimit } from '../lib/concurrency';
import { isRecord } from '../lib/type-guards';
import { claudeProjectDirSlug } from './claude-discovery';
import { listCodexDayDirectoriesNewestFirst } from './codex-discovery';
import {
  createReadPool,
  isoFromValue,
  laterIso,
  type ReadPool,
} from './file-head';
import {
  resolveClaudeConfigDir,
  resolveT3CodeDatabasePath,
  resolveT3CodeHome,
  resolveT3CodeStateDir,
  resolveCodexSessionsDir,
} from './provider-paths';
import type { StoreReadRunner } from './store-read-runner';
import { readStoreSnapshot, withStoreRunner } from './store-snapshot-read';
import { isT3Snapshot, type T3Project, type T3Thread } from './t3code-store';
import {
  DEFAULT_DISCOVERY_LIMITS,
  type AdapterResult,
  type DiscoveredRoot,
  type DiscoveredSession,
  type DiscoveryDiagnostic,
  type DiscoveryLimits,
} from './types';

/**
 * T3 Code discovery adapter. T3 Code is a front end over other agents: every
 * thread records the native session id of the agent that ran it. Projects
 * become roots and threads become sessions, in one of two tiers:
 *
 * - native: the agent is Codex, Claude, or OpenCode and its own record exists,
 *   so the thread can be imported through that agent's projection;
 * - history: anything else, imported as T3's own text copy.
 *
 * Discovery decides the tier only by whether the native record exists. The
 * store is read through {@link StoreReadRunner} (a worker reading a copy); this
 * file reads nothing else of T3's besides `settings.json`, for the per-instance
 * `CLAUDE_CONFIG_DIR`.
 */

export interface T3DiscoveryOptions {
  env?: Readonly<Record<string, string | undefined>>;
  limits?: DiscoveryLimits;
  dbPath?: string;
  /** Reads the store; the adapter creates (and closes) one when omitted. */
  runner?: StoreReadRunner;
  /** Where to look for a Claude transcript when the thread's instance sets no config dir. */
  claudeConfigDirs?: string[];
  /**
   * Sessions present in the OpenCode store with their message bytes, so its
   * threads can resolve (and size) a native record.
   */
  openCodeSessionSizes?: ReadonlyMap<string, number>;
  /** The OpenCode database those ids came from. */
  openCodeDbPath?: string;
}

type EnvLike = Readonly<Record<string, string | undefined>>;
type NativeProvider = 'claude' | 'codex' | 'opencode';
type Backing = NonNullable<DiscoveredSession['backing']>;

/** T3 names its Claude driver `claudeAgent`; `claude` is accepted for older records. */
function nativeProviderOf(driver: string | null): NativeProvider | null {
  if (driver === 'claudeAgent' || driver === 'claude') return 'claude';
  if (driver === 'codex') return 'codex';
  if (driver === 'opencode') return 'opencode';
  return null;
}

/** A native id becomes a path segment, so one carrying a separator must not resolve. */
function isSafeNativeId(id: string): boolean {
  return id !== '.' && id !== '..' && !/[\\/\0]/.test(id);
}

/** Windows paths compare case-insensitively; POSIX paths compare exactly. */
function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return hostOperatingSystem() === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/**
 * Finds `rollout-<timestamp>-<id>.jsonl` for the wanted ids across every Codex
 * day directory, newest first, stopping once all are found. Matching is by the
 * filename's trailing `-<id>` before `.jsonl`, so a `.jsonl.zst` (a compressed
 * rollout the Codex scan does not read either) never counts.
 */
async function findCodexRollouts(
  sessionsDir: string,
  wanted: ReadonlySet<string>,
  limits: DiscoveryLimits,
  pool: ReadPool,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (wanted.size === 0) return found;
  const dayDirs = await listCodexDayDirectoriesNewestFirst(sessionsDir);
  const width = normalizeLimit(limits.maxConcurrentReads);
  for (
    let start = 0;
    start < dayDirs.length && found.size < wanted.size;
    start += width
  ) {
    const batch = dayDirs.slice(start, start + width);
    const listings = await mapWithConcurrency(
      batch,
      width,
      async (dayDir): Promise<string[]> => {
        try {
          return await pool.run(() => readdir(dayDir));
        } catch {
          return [];
        }
      },
    );
    listings.forEach((names, index) => {
      const dayDir = batch[index];
      if (dayDir === undefined) return;
      for (const name of names) {
        if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
        const stem = name.slice(0, -'.jsonl'.length);
        // The id is whatever follows some dash of the stem (a UUID holds dashes itself).
        for (
          let dash = stem.indexOf('-');
          dash >= 0;
          dash = stem.indexOf('-', dash + 1)
        ) {
          const id = stem.slice(dash + 1);
          if (wanted.has(id) && !found.has(id)) {
            found.set(id, path.join(dayDir, name));
          }
        }
      }
    });
  }
  return found;
}

/**
 * `providerInstances[*].environment.CLAUDE_CONFIG_DIR` from T3's
 * `settings.json`, by instance id. Nothing else in the file is read.
 */
async function readClaudeInstanceConfigDirs(
  settingsPath: string,
  limits: DiscoveryLimits,
  pool: ReadPool,
  diagnostics: DiscoveryDiagnostic[],
): Promise<Map<string, string>> {
  const dirs = new Map<string, string>();
  let raw: string;
  try {
    const stats = await pool.run(() => stat(settingsPath));
    if (stats.size > limits.maxGlobalConfigBytes) {
      diagnostics.push({
        source: 't3code',
        message: `The T3 Code settings file is larger than ${Math.round(limits.maxGlobalConfigBytes / (1024 * 1024))} MB and was skipped; Claude threads were looked up in the default location.`,
      });
      return dirs;
    }
    raw = await pool.run(() => readFile(settingsPath, 'utf8'));
  } catch {
    return dirs;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return dirs;
  }
  if (!isRecord(parsed) || !isRecord(parsed.providerInstances)) return dirs;
  for (const [instanceId, instance] of Object.entries(
    parsed.providerInstances,
  )) {
    if (!isRecord(instance) || !isRecord(instance.environment)) continue;
    const configured = instance.environment.CLAUDE_CONFIG_DIR;
    if (typeof configured !== 'string') continue;
    const dir = configured.trim();
    if (dir && path.isAbsolute(dir)) dirs.set(instanceId, dir);
  }
  return dirs;
}

/** The file's size, or `null` when it is not a readable regular file. */
async function fileSize(
  filePath: string,
  pool: ReadPool,
): Promise<number | null> {
  try {
    const stats = await pool.run(() => stat(filePath));
    return stats.isFile() ? stats.size : null;
  } catch {
    return null;
  }
}

interface NativeResolvers {
  codexRollouts: ReadonlyMap<string, string>;
  claudeInstanceDirs: ReadonlyMap<string, string>;
  defaultClaudeDirs: readonly string[];
  openCodeSessionSizes: ReadonlyMap<string, number>;
  openCodeDbPath: string | undefined;
  pool: ReadPool;
}

/**
 * The native record behind a thread, or `undefined` when the thread belongs in
 * the history tier: no recorded session, a driver Canopy has no reader for, or
 * a record that is not on disk.
 */
async function resolveBacking(
  thread: T3Thread,
  project: T3Project,
  resolvers: NativeResolvers,
): Promise<Backing | undefined> {
  const provider = nativeProviderOf(thread.driver);
  const nativeId = thread.nativeId;
  if (!provider || !nativeId || !isSafeNativeId(nativeId)) return undefined;
  // The import budgets a backed thread by its native record, so each one
  // carries that record's size.
  if (provider === 'codex') {
    const sourcePath = resolvers.codexRollouts.get(nativeId);
    const sizeBytes = sourcePath
      ? await fileSize(sourcePath, resolvers.pool)
      : null;
    return sourcePath && sizeBytes !== null
      ? { provider, kind: 'codex-rollout', sourcePath, id: nativeId, sizeBytes }
      : undefined;
  }
  if (provider === 'opencode') {
    const sizeBytes = resolvers.openCodeSessionSizes.get(nativeId);
    // Without the database path there is no source to point the import at.
    if (!resolvers.openCodeDbPath || sizeBytes === undefined) return undefined;
    return {
      provider,
      kind: 'opencode-session',
      sourcePath: resolvers.openCodeDbPath,
      id: nativeId,
      sizeBytes,
    };
  }
  // The transcript sits under the slug of the folder the agent ran in.
  const cwd = thread.worktreePath ?? project.workspaceRoot;
  const configured = thread.providerInstanceId
    ? resolvers.claudeInstanceDirs.get(thread.providerInstanceId)
    : undefined;
  const configDirs = configured ? [configured] : resolvers.defaultClaudeDirs;
  for (const configDir of configDirs) {
    const sourcePath = path.join(
      configDir,
      'projects',
      claudeProjectDirSlug(cwd),
      `${nativeId}.jsonl`,
    );
    const sizeBytes = await fileSize(sourcePath, resolvers.pool);
    if (sizeBytes !== null) {
      return {
        provider,
        kind: 'claude-jsonl',
        sourcePath,
        id: nativeId,
        sizeBytes,
      };
    }
  }
  return undefined;
}

function sessionFor(
  thread: T3Thread,
  project: T3Project,
  dbPath: string,
  backing: Backing | undefined,
): DiscoveredSession {
  return {
    id: backing ? backing.id : thread.threadId,
    storeId: thread.threadId,
    provider: 't3code',
    surface: 't3-code',
    kind: 't3-thread',
    cwd: thread.worktreePath ?? project.workspaceRoot,
    sourcePath: dbPath,
    title: thread.title.trim() || null,
    startedAt: isoFromValue(thread.createdAt),
    lastActivityAt: isoFromValue(thread.updatedAt),
    sizeBytes: thread.messageBytes,
    native: true,
    archived: thread.archivedAt !== null,
    ...(thread.driver ? { driver: thread.driver } : {}),
    ...(backing ? { backing } : {}),
    // Kept in either tier: the native id is how a chat imported earlier
    // through the agent's own record is recognized once that record is gone.
    ...(thread.nativeId && isSafeNativeId(thread.nativeId)
      ? { aliasIds: [thread.nativeId] }
      : {}),
  };
}

/**
 * Discovers T3 Code projects as roots and threads as sessions. The scratch
 * ("No project") threads are excluded and counted, since each lives in its own
 * throwaway folder that is not a project anyone chose. A thread with nothing
 * to import (no rows of its own and no non-empty native record) is dropped.
 */
export async function discoverT3CodeProjects(
  options: T3DiscoveryOptions = {},
): Promise<AdapterResult & { scratchThreadsSkipped: number }> {
  const env: EnvLike = options.env ?? process.env;
  const limits = options.limits ?? DEFAULT_DISCOVERY_LIMITS;
  const dbPath = options.dbPath ?? resolveT3CodeDatabasePath(env);
  const diagnostics: DiscoveryDiagnostic[] = [];
  const empty = (
    detected: boolean,
  ): AdapterResult & { scratchThreadsSkipped: number } => ({
    roots: [],
    diagnostics,
    detected,
    scratchThreadsSkipped: 0,
  });

  const result = await withStoreRunner(options.runner, (runner) =>
    readStoreSnapshot(
      runner,
      { store: 't3code', dbPath, mode: 'snapshot' },
      { source: 't3code', label: 'T3 Code', guard: isT3Snapshot },
    ),
  );
  if (result.kind === 'absent') return empty(false);
  if (result.kind === 'failed') {
    diagnostics.push(result.diagnostic);
    return empty(true);
  }
  const { snapshot } = result;

  // The worker flags the scratch shape; only the adapter knows the T3 home.
  const scratchRoot = path.join(resolveT3CodeHome(env), 'scratch');
  const scratchIds = new Set(
    snapshot.projects
      .filter(
        (project) =>
          snapshot.scratchProjectIds.includes(project.projectId) &&
          samePath(project.workspaceRoot, scratchRoot),
      )
      .map((project) => project.projectId),
  );
  const projects = snapshot.projects.filter(
    (project) =>
      !scratchIds.has(project.projectId) &&
      path.isAbsolute(project.workspaceRoot),
  );
  const projectsById = new Map(
    projects.map((project) => [project.projectId, project]),
  );
  const scratchThreadsSkipped = snapshot.threads.filter((thread) =>
    scratchIds.has(thread.projectId),
  ).length;
  const threads = snapshot.threads.filter((thread) =>
    projectsById.has(thread.projectId),
  );

  // One pool for every directory listing, stat, and file read of the scan.
  const pool = createReadPool(limits.maxConcurrentReads);
  const nativeProviders = new Set(
    threads.map((thread) => nativeProviderOf(thread.driver)),
  );
  const codexIds = new Set(
    threads
      .filter(
        (thread) =>
          nativeProviderOf(thread.driver) === 'codex' &&
          thread.nativeId !== null &&
          isSafeNativeId(thread.nativeId),
      )
      .map((thread) => thread.nativeId ?? ''),
  );
  const stateDir = options.dbPath
    ? path.dirname(options.dbPath)
    : resolveT3CodeStateDir(env);
  const [codexRollouts, claudeInstanceDirs] = await Promise.all([
    nativeProviders.has('codex')
      ? findCodexRollouts(resolveCodexSessionsDir(env), codexIds, limits, pool)
      : new Map<string, string>(),
    nativeProviders.has('claude')
      ? readClaudeInstanceConfigDirs(
          path.join(stateDir, 'settings.json'),
          limits,
          pool,
          diagnostics,
        )
      : new Map<string, string>(),
  ]);
  const resolvers: NativeResolvers = {
    codexRollouts,
    claudeInstanceDirs,
    defaultClaudeDirs: options.claudeConfigDirs ?? [
      resolveClaudeConfigDir(env),
    ],
    openCodeSessionSizes:
      options.openCodeSessionSizes ?? new Map<string, number>(),
    openCodeDbPath: options.openCodeDbPath,
    pool,
  };

  const resolved = await mapWithConcurrency(
    threads,
    limits.maxConcurrentReads,
    async (thread): Promise<DiscoveredSession | null> => {
      const project = projectsById.get(thread.projectId);
      if (!project) return null;
      const backing = await resolveBacking(thread, project, resolvers);
      // A thread with no message or turn-item rows and no non-empty native
      // record has nothing to import. Listing it would plan it on every
      // import, since an empty chat is never ledgered.
      if (thread.messageBytes === 0 && (backing?.sizeBytes ?? 0) === 0)
        return null;
      return sessionFor(thread, project, dbPath, backing);
    },
  );
  const sessionsByProject = new Map<string, DiscoveredSession[]>();
  threads.forEach((thread, index) => {
    const session = resolved[index];
    if (!session) return;
    const list = sessionsByProject.get(thread.projectId) ?? [];
    list.push(session);
    sessionsByProject.set(thread.projectId, list);
  });

  const roots: DiscoveredRoot[] = projects.map((project) => {
    const sessions = sessionsByProject.get(project.projectId) ?? [];
    return {
      provider: 't3code',
      surface: 't3-code',
      rootPath: project.workspaceRoot,
      displayName: project.title,
      lastActivityAt: sessions.reduce<string | null>(
        (latest, session) => laterIso(latest, session.lastActivityAt),
        isoFromValue(project.updatedAt),
      ),
      sessions,
    };
  });

  return { roots, diagnostics, detected: true, scratchThreadsSkipped };
}
