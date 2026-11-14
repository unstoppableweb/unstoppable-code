import path from 'node:path';
import { isPathInside } from '../lib/path-safety';
import { isoFromMs, laterIso } from './file-head';
import { isOpenCodeSnapshot, type OpenCodeSession } from './opencode-store';
import { resolveOpenCodeDatabasePath } from './provider-paths';
import type { StoreReadRunner } from './store-read-runner';
import { readStoreSnapshot, withStoreRunner } from './store-snapshot-read';
import {
  DEFAULT_DISCOVERY_LIMITS,
  type AdapterResult,
  type DiscoveredRoot,
  type DiscoveredSession,
  type DiscoveryDiagnostic,
  type DiscoveryLimits,
} from './types';

/**
 * OpenCode discovery adapter. OpenCode keeps every transcript in one SQLite
 * database: projects become roots and top-level sessions become sessions.
 * Canopy's own OpenCode chats land in the same database, so the adapter drops
 * the sessions Canopy owns, by id and by the folder they ran in, rather than
 * offering them back for import. The store is read through
 * {@link StoreReadRunner} (a worker reading a copy); nothing else of
 * OpenCode's is read.
 */

export interface OpenCodeDiscoveryOptions {
  env?: Readonly<Record<string, string | undefined>>;
  limits?: DiscoveryLimits;
  dbPath?: string;
  /** Reads the store; the adapter creates (and closes) one when omitted. */
  runner?: StoreReadRunner;
  /** Folders whose sessions are never offered (Canopy's own data roots, the OS temp root). */
  excludedRoots: string[];
  /** Native session ids Canopy's own OpenCode chats recorded. */
  ownSessionIds: ReadonlySet<string>;
}

type EnvLike = Readonly<Record<string, string | undefined>>;

function sessionFor(
  session: OpenCodeSession,
  dbPath: string,
): DiscoveredSession {
  return {
    id: session.id,
    storeId: session.id,
    provider: 'opencode',
    surface: 'opencode',
    kind: 'opencode-session',
    cwd: session.directory,
    sourcePath: dbPath,
    title: session.title?.trim() || null,
    startedAt: isoFromMs(session.timeCreated),
    lastActivityAt: isoFromMs(session.timeUpdated),
    sizeBytes: session.messageBytes,
    native: true,
    archived: session.timeArchived !== null,
  };
}

function isFilesystemRoot(candidate: string): boolean {
  return path.parse(candidate).root === candidate;
}

function latestActivity(sessions: DiscoveredSession[]): string | null {
  return sessions.reduce<string | null>(
    (latest, session) => laterIso(latest, session.lastActivityAt),
    null,
  );
}

/**
 * Discovers OpenCode projects as roots and top-level sessions as sessions. A
 * project's `worktree` is its main checkout, while Canopy runs its chats in
 * linked worktrees, so exclusion tests each session's own `directory`; a root
 * left with no sessions is dropped, and so is a session with no message rows. OpenCode files every session started
 * outside a repository under one global project whose `worktree` is the
 * filesystem root, so that project's sessions become one root per folder they
 * ran in; a session that ran in the filesystem root itself is counted in a
 * diagnostic instead.
 */
export async function discoverOpenCodeProjects(
  options: OpenCodeDiscoveryOptions,
): Promise<AdapterResult> {
  const env: EnvLike = options.env ?? process.env;
  const limits = options.limits ?? DEFAULT_DISCOVERY_LIMITS;
  const dbPath = options.dbPath ?? resolveOpenCodeDatabasePath(env);
  const diagnostics: DiscoveryDiagnostic[] = [];

  const result = await withStoreRunner(options.runner, (runner) =>
    readStoreSnapshot(
      runner,
      {
        store: 'opencode',
        dbPath,
        mode: 'snapshot',
        maxSessions: limits.maxSessionFiles,
      },
      { source: 'opencode', label: 'OpenCode', guard: isOpenCodeSnapshot },
    ),
  );
  if (result.kind === 'absent')
    return { roots: [], diagnostics, detected: false };
  if (result.kind === 'failed') {
    diagnostics.push(result.diagnostic);
    return { roots: [], diagnostics, detected: true };
  }
  const { snapshot } = result;

  const sessionsByProject = new Map<string, DiscoveredSession[]>();
  for (const session of snapshot.sessions) {
    // A session with no message rows was opened and never used. Listing it
    // would plan it on every import, since an empty chat is never ledgered.
    if (session.messageBytes === 0) continue;
    if (options.ownSessionIds.has(session.id)) continue;
    if (
      options.excludedRoots.some((excluded) =>
        isPathInside(excluded, session.directory),
      )
    )
      continue;
    const list = sessionsByProject.get(session.projectId) ?? [];
    list.push(sessionFor(session, dbPath));
    sessionsByProject.set(session.projectId, list);
  }

  const roots: DiscoveredRoot[] = [];
  let rootlessSessions = 0;
  for (const project of snapshot.projects) {
    const sessions = sessionsByProject.get(project.id);
    if (!sessions || sessions.length === 0) continue;
    if (!isFilesystemRoot(project.worktree)) {
      roots.push({
        provider: 'opencode',
        surface: 'opencode',
        rootPath: project.worktree,
        displayName: project.name ?? undefined,
        lastActivityAt: latestActivity(sessions),
        sessions,
      });
      continue;
    }
    const byDirectory = new Map<string, DiscoveredSession[]>();
    for (const session of sessions) {
      if (isFilesystemRoot(session.cwd)) {
        rootlessSessions += 1;
        continue;
      }
      const list = byDirectory.get(session.cwd) ?? [];
      list.push(session);
      byDirectory.set(session.cwd, list);
    }
    for (const [directory, folderSessions] of byDirectory) {
      roots.push({
        provider: 'opencode',
        surface: 'opencode',
        rootPath: directory,
        lastActivityAt: latestActivity(folderSessions),
        sessions: folderSessions,
      });
    }
  }
  if (rootlessSessions > 0) {
    diagnostics.push({
      source: 'opencode',
      message: `${rootlessSessions} OpenCode ${rootlessSessions === 1 ? 'chat' : 'chats'} started outside any folder ${rootlessSessions === 1 ? 'was' : 'were'} skipped.`,
    });
  }

  return { roots, diagnostics, detected: true };
}
