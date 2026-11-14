import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { BRAND } from '@canopy/brand/current';
import { readGitHeadState } from '@canopy/core-runtime/node/git';
import {
  EXTERNAL_PROJECT_PROVIDERS,
  type ExternalProjectCandidate,
  type ExternalProjectDetectedPlugin,
  type ExternalProjectDiscoverRequest,
  type ExternalProjectDiscoverResponse,
  type ExternalProjectProvider,
  type SidebarItem,
} from '@canopy/desktop-shared/types';
import { getGitCommonDir, getWorktreeTopLevel } from '../lib/git';
import { readPreferencesFile } from '../lib/preferences-store';
import { readAllSidebarItems } from '../lib/sidebar-items';
import { readWorkspaceConfigDetailed } from '../lib/workspace-persistence';
import { requestChatHistoryProfileRefresh } from '../memory/local/chat-history-profile-refresh';
import { loadMarketplacesCacheOnly } from '../plugins/plugin-service';
import { collectChatHistoryProfileInput } from './chat-history-titles';
import { discoverClaudeProjects } from './claude-discovery';
import { discoverCodexProjects } from './codex-discovery';
import {
  markExternalProjectScan,
  readExternalProjectImportLedger,
} from './ledger';
import {
  normalizeDiscoveredRoots,
  preferredSession,
  type ExistingWorkspaceIdentity,
  type NormalizeDeps,
} from './normalize';
import { findNestedRepositories } from './nested-repositories';
import { collectExcludedRoots, safeRealpath } from './excluded-roots';
import { discoverOpenCodeProjects } from './opencode-discovery';
import { collectOwnOpenCodeSessionIds } from './own-opencode-sessions';
import {
  resolveClaudeDesktopCoworkSessionsDir,
  resolveClaudeDesktopDataDir,
  resolveOpenCodeDatabasePath,
} from './provider-paths';
import { StoreReadRunner } from './store-read-runner';
import { discoverT3CodeProjects } from './t3code-discovery';
import type {
  AdapterResult,
  DiscoveredRoot,
  DiscoveredSession,
  DiscoveryDiagnostic,
} from './types';

/**
 * Discovery orchestrator for the bulk project import (CAN-2439): runs the
 * provider adapters, normalizes their evidence against the workspace registry
 * and the import ledger, and caches the result so a later import request can
 * reference the exact candidates the user reviewed (`scanId`).
 *
 * Discovery is user-triggered (onboarding step, settings, checklist), never
 * desktop-startup work, and completes with per-adapter diagnostics instead of
 * failing as a whole when one store is unreadable.
 */

const MAX_SESSIONS_PER_CANDIDATE = 50;
const MAX_UNAVAILABLE_CANDIDATES = 25;
const SCAN_CACHE_LIMIT = 4;

export interface CachedScan {
  scanId: string;
  scannedAt: string;
  candidates: ExternalProjectCandidate[];
  /** Raw sessions per candidate id, needed to import chats later. */
  sessionsByCandidate: Map<string, DiscoveredSession[]>;
}

const scanCache = new Map<string, CachedScan>();

export function getCachedExternalProjectScan(
  scanId: string,
): CachedScan | null {
  return scanCache.get(scanId) ?? null;
}

async function describeExistingWorkspaces(
  items: SidebarItem[],
): Promise<ExistingWorkspaceIdentity[]> {
  const out: ExistingWorkspaceIdentity[] = [];
  for (const item of items) {
    const rootPaths: string[] = [];
    const gitRoots: string[] = [];
    if (item.type === 'single-repo') {
      rootPaths.push(item.repoPath);
      gitRoots.push(item.repoPath);
    } else if (item.type === 'multi-repo') {
      if (item.sourceRepoPath) {
        rootPaths.push(item.sourceRepoPath);
        gitRoots.push(item.sourceRepoPath);
      }
      for (const repo of item.repos) {
        rootPaths.push(repo.repoPath);
        gitRoots.push(repo.repoPath);
      }
    } else if (item.externalPath) {
      rootPaths.push(item.externalPath);
    }
    const canonicalRoots = await Promise.all(rootPaths.map(safeRealpath));
    const gitCommonDirs = (
      await Promise.all(
        gitRoots.map((repoPath) => getGitCommonDir(repoPath).catch(() => null)),
      )
    ).filter((value): value is string => value !== null);
    out.push({
      id: item.id,
      name: item.name,
      type: item.type,
      rootPaths: canonicalRoots,
      gitCommonDirs,
    });
  }
  return out;
}

const normalizeDeps: NormalizeDeps = {
  realpath: (candidate) => realpath(candidate),
  isDirectory: async (candidate) => {
    try {
      return (await stat(candidate)).isDirectory();
    } catch {
      return false;
    }
  },
  gitTopLevel: async (directory) => {
    try {
      return await getWorktreeTopLevel(directory);
    } catch (error) {
      // A definitive negative is distinct from timeout, permission or launch failure.
      if (
        error instanceof Error &&
        /fatal: not a git repository\b/i.test(error.message)
      ) {
        return null;
      }
      throw error;
    }
  },
  gitCommonDir: (topLevel) => getGitCommonDir(topLevel),
  findNestedRepositories,
};

/**
 * Plugins the user already installed in Claude Code or Codex that are not
 * yet on Canopy's global plugin list. Read from the marketplace cache only;
 * discovery must never spawn a provider CLI.
 */
export async function detectProviderPlugins(): Promise<
  ExternalProjectDetectedPlugin[]
> {
  const [cache, preferences] = await Promise.all([
    loadMarketplacesCacheOnly().catch(() => null),
    readPreferencesFile().catch(() => null),
  ]);
  if (!cache?.success || !cache.data) return [];
  const selected = new Set(
    (preferences?.globalPluginSelections?.pluginRefs ?? []).map(
      (ref) => `${ref.marketplaceId} ${ref.pluginName}`,
    ),
  );
  const detected: ExternalProjectDetectedPlugin[] = [];
  for (const marketplace of cache.data.marketplaces) {
    for (const plugin of marketplace.plugins) {
      const providers: ExternalProjectProvider[] = [];
      if (plugin.globalInstallStatus?.claude?.installed === true) {
        providers.push('claude');
      }
      if (plugin.globalInstallStatus?.codex?.installed === true) {
        providers.push('codex');
      }
      if (providers.length === 0) continue;
      if (selected.has(`${marketplace.id} ${plugin.name}`)) continue;
      detected.push({
        marketplaceId: marketplace.id,
        pluginName: plugin.name,
        displayName: plugin.displayName ?? plugin.name,
        providers,
      });
    }
  }
  return detected;
}

export async function discoverExternalProjects(
  request: ExternalProjectDiscoverRequest,
  signal?: AbortSignal,
): Promise<ExternalProjectDiscoverResponse> {
  signal?.throwIfAborted();
  const providers = new Set<ExternalProjectProvider>(
    request.providers && request.providers.length > 0
      ? request.providers
      : EXTERNAL_PROJECT_PROVIDERS,
  );
  const diagnostics: DiscoveryDiagnostic[] = [];
  const roots: DiscoveredRoot[] = [];
  const providersDetected: Record<ExternalProjectProvider, boolean> = {
    claude: false,
    codex: false,
    t3code: false,
    opencode: false,
  };

  // Resolved once and shared with the normalizer below, so the folder tree
  // the Claude adapter reads is the same one whose per-session scratch
  // folders are named after their sessions.
  const claudeDesktopDir = resolveClaudeDesktopDataDir();
  // Also resolved before the adapters run: the Claude adapter skips project
  // directories under these roots instead of reading transcripts the
  // normalizer would only discard, and the OpenCode adapter drops sessions
  // run there (Canopy's own worktrees, and temp roots unless E2E lifts that).
  const [excludedRoots, ownOpenCodeSessionIds] = await Promise.all([
    collectExcludedRoots(),
    providers.has('opencode')
      ? collectOwnOpenCodeSessionIds({
          onTruncated: (skipped) =>
            diagnostics.push({
              source: 'opencode',
              message: `${skipped} OpenCode session ${skipped === 1 ? 'record' : 'records'} from this app ${skipped === 1 ? 'was' : 'were'} not read, so some chats it ran in OpenCode may be listed.`,
            }),
        })
      : Promise.resolve(new Set<string>()),
  ]);
  // The memory profile is rebuilt from the whole history, so only a scan
  // that read every provider may replace it.
  let scannedWholeHistory = EXTERNAL_PROJECT_PROVIDERS.every((provider) =>
    providers.has(provider),
  );
  const record = (
    provider: ExternalProjectProvider,
    result: AdapterResult,
  ): void => {
    roots.push(...result.roots);
    diagnostics.push(...result.diagnostics);
    providersDetected[provider] = result.detected;
  };
  const recordFailure = (
    provider: ExternalProjectProvider,
    label: string,
    error: unknown,
  ): void => {
    scannedWholeHistory = false;
    diagnostics.push({
      source: provider,
      message: `${label} projects could not be scanned: ${error instanceof Error ? error.message : String(error)}`,
    });
  };

  const adapters: Promise<void>[] = [];
  if (providers.has('claude')) {
    adapters.push(
      discoverClaudeProjects({
        desktopDataDir: claudeDesktopDir,
        excludedRoots,
      }).then(
        (result) => record('claude', result),
        (error: unknown) => recordFailure('claude', 'Claude', error),
      ),
    );
  }
  if (providers.has('codex')) {
    adapters.push(
      discoverCodexProjects({ ownOriginators: [BRAND.id, 'canopy'] }).then(
        (result) => record('codex', result),
        (error: unknown) => recordFailure('codex', 'Codex', error),
      ),
    );
  }
  // One store read worker serves both SQLite stores for the whole scan.
  const storeRunner = new StoreReadRunner();
  try {
    // T3 threads backed by OpenCode resolve against the sessions the OpenCode
    // scan found, so T3 waits for it; Claude and Codex never wait.
    let openCodeSessionSizes: Promise<ReadonlyMap<string, number>> =
      Promise.resolve(new Map<string, number>());
    if (providers.has('opencode')) {
      openCodeSessionSizes = discoverOpenCodeProjects({
        runner: storeRunner,
        excludedRoots,
        ownSessionIds: ownOpenCodeSessionIds,
      }).then(
        (result) => {
          record('opencode', result);
          return new Map(
            result.roots.flatMap((root) =>
              root.sessions.map((session): [string, number] => [
                session.id,
                session.sizeBytes,
              ]),
            ),
          );
        },
        (error: unknown) => {
          recordFailure('opencode', 'OpenCode', error);
          return new Map<string, number>();
        },
      );
      adapters.push(openCodeSessionSizes.then(() => undefined));
    }
    if (providers.has('t3code')) {
      adapters.push(
        openCodeSessionSizes
          .then((sizes) =>
            discoverT3CodeProjects({
              runner: storeRunner,
              openCodeSessionSizes: sizes,
              openCodeDbPath: resolveOpenCodeDatabasePath(),
            }),
          )
          .then(
            (result) => {
              record('t3code', result);
              const skipped = result.scratchThreadsSkipped;
              if (skipped > 0) {
                diagnostics.push({
                  source: 't3code',
                  message: `${skipped} "No project" ${skipped === 1 ? 'chat was' : 'chats were'} skipped.`,
                });
              }
            },
            (error: unknown) => recordFailure('t3code', 'T3 Code', error),
          ),
      );
    }
    await Promise.all(adapters);
  } finally {
    await storeRunner.close();
  }

  for (const customRoot of request.customRoots ?? []) {
    if (typeof customRoot !== 'string' || !path.isAbsolute(customRoot)) {
      continue;
    }
    roots.push({
      provider: 'claude',
      surface: 'custom-folder',
      rootPath: customRoot,
      lastActivityAt: null,
      sessions: [],
    });
  }

  const [sidebar, ledger] = await Promise.all([
    readAllSidebarItems(),
    readExternalProjectImportLedger(),
  ]);
  const existingWorkspaces = await describeExistingWorkspaces(sidebar.items);
  const home = await safeRealpath(homedir());
  // Folder-less Cowork sessions run in per-session scratch folders under
  // this tree; the normalizer names those after the session, not the folder.
  const sessionScratchRoots = claudeDesktopDir
    ? [
        await safeRealpath(
          resolveClaudeDesktopCoworkSessionsDir(claudeDesktopDir),
        ),
      ]
    : [];

  const normalized = await normalizeDiscoveredRoots(
    roots,
    {
      excludedRoots,
      excludedExact: [home],
      existingWorkspaces,
      ledger,
      sessionScratchRoots,
      maxSessionsPerCandidate: MAX_SESSIONS_PER_CANDIDATE,
      maxUnavailableCandidates: MAX_UNAVAILABLE_CANDIDATES,
      maxNestedRepositoriesListed: 20,
    },
    normalizeDeps,
  );
  diagnostics.push(...normalized.diagnostics);

  // Custom folders carry no provider evidence; drop the synthetic provider
  // marker so the UI shows them as a picked folder, not a Claude project.
  const candidates = normalized.candidates.map((candidate) =>
    candidate.surfaces.every(
      (surface) =>
        surface === 'custom-folder' || surface === 'nested-repository',
    )
      ? { ...candidate, providers: [] }
      : candidate,
  );

  const sessionsByCandidate = new Map<string, DiscoveredSession[]>();
  // Bound filesystem concurrency and bytes; never launch Git per candidate.
  // Read the final candidate root, not a linked sibling folded into its family.
  let headStateIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, candidates.length) }, async () => {
      while (headStateIndex < candidates.length) {
        signal?.throwIfAborted();
        const candidate = candidates[headStateIndex++];
        if (candidate.kind !== 'git') continue;
        const state = await readGitHeadState(candidate.rootPath, { signal });
        signal?.throwIfAborted();
        if (state.headUnborn !== undefined)
          candidate.headUnborn = state.headUnborn;
      }
    }),
  );
  for (const candidate of candidates) {
    sessionsByCandidate.set(
      candidate.id,
      collectSessionsForCandidate(
        normalized.nativeSessionIdsByCandidate.get(candidate.id) ?? [],
        roots,
      ),
    );
  }

  const scanId = randomUUID();
  const scannedAt = new Date().toISOString();
  scanCache.set(scanId, { scanId, scannedAt, candidates, sessionsByCandidate });
  while (scanCache.size > SCAN_CACHE_LIMIT) {
    // Insertion order: the first key is the oldest scan.
    const oldest = scanCache.keys().next().value;
    if (oldest === undefined) break;
    scanCache.delete(oldest);
  }
  await markExternalProjectScan(scannedAt).catch(() => undefined);
  // What the titles say about the user goes to their memory profile
  // (CAN-3079) in the background; the scan result never waits for it. A
  // partial scan would rebuild the profile from part of the history. The
  // titles are collected inside the refresh, only once local memory is known
  // to be on, where a failure cannot reach this response.
  if (scannedWholeHistory) {
    void requestChatHistoryProfileRefresh(async () => {
      const currentItems = (await readAllSidebarItems()).items;
      const privateRoots = new Set<string>();
      for (const item of currentItems) {
        const read = await readWorkspaceConfigDetailed(item.id);
        if (
          read.authority === 'ok' &&
          !read.memoryMalformed &&
          read.config.privateMemory !== true
        )
          continue;
        const paths =
          item.type === 'single-repo'
            ? [item.repoPath, item.externalPath]
            : item.type === 'multi-repo'
              ? [
                  item.sourceRepoPath,
                  item.externalPath,
                  ...item.repos.map((repo) => repo.repoPath),
                ]
              : [item.externalPath];
        for (const root of paths) {
          if (!root) continue;
          privateRoots.add(path.resolve(root));
          privateRoots.add(await safeRealpath(root));
        }
      }
      return collectChatHistoryProfileInput({
        roots,
        candidates,
        sessionsByCandidate,
        excludedRoots,
        privateRoots: Array.from(privateRoots),
      });
    });
  }

  return {
    scanId,
    scannedAt,
    candidates,
    diagnostics,
    providersDetected,
    detectedPlugins: await detectProviderPlugins(),
  };
}

/**
 * Raw sessions an import may bring in for one candidate. Matching is by
 * session id against the normalizer's unbounded native id set, never the
 * capped display list, so a project with more chats than the picker shows
 * still imports all of them (up to the per-run import cap).
 */
export function collectSessionsForCandidate(
  sessionIds: readonly string[],
  roots: DiscoveredRoot[],
): DiscoveredSession[] {
  const wanted = new Set(sessionIds);
  // The same rule as the normalizer's, so the session imported is the row shown.
  const byId = new Map<string, DiscoveredSession>();
  for (const root of roots) {
    for (const session of root.sessions) {
      if (!wanted.has(session.id)) continue;
      const existing = byId.get(session.id);
      byId.set(
        session.id,
        existing ? preferredSession(existing, session) : session,
      );
    }
  }
  return Array.from(byId.values());
}

export function resetExternalProjectScanCacheForTests(): void {
  scanCache.clear();
}
