import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  ExternalProjectCandidate,
  ExternalProjectCandidateStatus,
  ExternalProjectNestedRepositories,
  ExternalProjectProvider,
  ExternalProjectSessionSummary,
  ExternalProjectSurface,
} from '@canopy/desktop-shared/types';
import { isPathInside } from '../lib/path-safety';
import { compareText, laterIso } from './file-head';
import {
  findImportedSession,
  type ExternalProjectImportLedger,
  type ExternalProjectImportedSession,
} from './ledger';
import type { NestedRepositoryScan } from './nested-repositories';
import type {
  DiscoveredRoot,
  DiscoveredSession,
  DiscoveryDiagnostic,
} from './types';

/**
 * Turns raw adapter evidence into renderer-facing candidates (CAN-2439):
 *
 * 1. canonicalize each root (`realpath`), dropping roots that do not exist,
 *    are not directories, or fall under an excluded tree (Canopy data dirs,
 *    temp dirs, the home directory itself, provider-managed worktrees);
 * 2. resolve git identity so a session recorded in a subdirectory attaches to
 *    its repository root, and linked worktrees fold into one repository
 *    family keyed by the git common directory;
 * 3. merge roots by canonical path across providers and surfaces;
 * 4. compare against the workspace registry and the import ledger so nothing
 *    already tracked is offered for import again;
 * 5. name every candidate so it can be told apart (CAN-3076): a provider's
 *    own project name, else the newest chat title for a per-session scratch
 *    folder, else the folder name widened by parent folders when it repeats.
 *
 * Filesystem and git access are injected so the rules are unit-testable
 * without a real provider store.
 */

export interface NormalizeDeps {
  realpath(candidate: string): Promise<string>;
  isDirectory(candidate: string): Promise<boolean>;
  /** Repository top level for a directory, or `null` when not inside a repo. */
  gitTopLevel(directory: string): Promise<string | null>;
  /** Git common directory (realpath) for a repository top level, or `null`. */
  gitCommonDir(topLevel: string): Promise<string | null>;
  findNestedRepositories(root: string): Promise<NestedRepositoryScan>;
}

export interface ExistingWorkspaceIdentity {
  id: string;
  name: string;
  type: 'single-repo' | 'multi-repo' | 'cowork';
  /** Canonical root paths this project already owns. */
  rootPaths: string[];
  /** Git common directories for the git-backed roots, when resolvable. */
  gitCommonDirs: string[];
}

export interface NormalizeContext {
  /** Canonical directories whose contents can never be project candidates. */
  excludedRoots: string[];
  /** Canonical directories that themselves can never be candidates (e.g. `~`). */
  excludedExact: string[];
  existingWorkspaces: ExistingWorkspaceIdentity[];
  ledger: ExternalProjectImportLedger;
  /**
   * Canonical directories under which every folder is a provider's
   * per-session scratch space (Claude Desktop's folder-less Cowork sessions).
   * Such a folder is named after its newest titled chat, since its own name
   * is a repeated `outputs`.
   */
  sessionScratchRoots: string[];
  /** Sessions listed per candidate; the total is still reported. */
  maxSessionsPerCandidate: number;
  /** Unavailable roots surfaced as candidates; the remainder is a diagnostic. */
  maxUnavailableCandidates: number;
  /** Confirmed nested repositories listed per explicitly picked parent. */
  maxNestedRepositoriesListed: number;
}

export interface NormalizeResult {
  candidates: ExternalProjectCandidate[];
  diagnostics: DiscoveryDiagnostic[];
  /**
   * Every native session id per candidate, unbounded. `candidate.sessions`
   * is the display list capped at `maxSessionsPerCandidate`; import
   * eligibility must come from this map so the number the user is shown is
   * the number that can be imported.
   */
  nativeSessionIdsByCandidate: Map<string, string[]>;
}

export function externalProjectCandidateId(canonicalRootPath: string): string {
  const digest = createHash('sha256')
    .update(canonicalRootPath)
    .digest('hex')
    .slice(0, 24);
  return `ext-${digest}`;
}

interface WorkingCandidate {
  rootPath: string;
  kind: 'git' | 'folder';
  gitCommonDir: string | null;
  providers: Set<ExternalProjectProvider>;
  surfaces: Set<ExternalProjectSurface>;
  displayName: string | null;
  lastActivityAt: string | null;
  sessions: Map<string, DiscoveredSession>;
  linkedWorktreePaths: Set<string>;
  listed: boolean;
  parentCandidateIds: Set<string>;
  nestedRepositories?: ExternalProjectNestedRepositories;
}

interface UnavailableRoot {
  /** Normalized once in `recordUnavailable`; groups, names, ids, and widens. */
  rootPath: string;
  providers: Set<ExternalProjectProvider>;
  surfaces: Set<ExternalProjectSurface>;
  /** Native sessions across every root reporting the folder, for naming. */
  sessions: DiscoveredSession[];
  /** Provider-assigned name from whichever reporting root carried one. */
  displayName: string | null;
  nativeSessionCount: number;
  reason: string;
  lastActivityAt: string | null;
}

type DisplayNameSource = 'provider' | 'session' | 'path';

interface NamedCandidate {
  candidate: ExternalProjectCandidate;
  nameSource: DisplayNameSource;
}

/** Path-derived names grow by at most this many folders when they repeat. */
const MAX_DISPLAY_NAME_SEGMENTS = 3;

interface CandidateStatus {
  status: ExternalProjectCandidateStatus;
  statusReason?: string;
  trackedWorkspaceId?: string;
}

const MISSING_FOLDER_REASON =
  'Folder not found. Its chats can be imported once the folder is back.';

function newWorkingCandidate(
  rootPath: string,
  kind: 'git' | 'folder',
  gitCommonDir: string | null,
): WorkingCandidate {
  return {
    rootPath,
    kind,
    gitCommonDir,
    providers: new Set(),
    surfaces: new Set(),
    displayName: null,
    lastActivityAt: null,
    sessions: new Map(),
    linkedWorktreePaths: new Set(),
    listed: false,
    parentCandidateIds: new Set(),
  };
}

function mergeSessionInto(
  target: WorkingCandidate,
  session: DiscoveredSession,
): void {
  target.surfaces.add(session.surface);
  target.providers.add(session.provider);
  target.lastActivityAt = laterIso(
    target.lastActivityAt,
    session.lastActivityAt,
  );
  const existing = target.sessions.get(session.id);
  if (!existing) {
    target.sessions.set(session.id, session);
    return;
  }
  // The provider of the session not kept stays on the candidate (above).
  const kept = preferredSession(existing, session);
  const other = kept === existing ? session : existing;
  target.sessions.set(session.id, {
    ...kept,
    title: kept.title ?? other.title,
    lastActivityAt: laterIso(kept.lastActivityAt, other.lastActivityAt),
  });
}

function isBackedT3Session(session: DiscoveredSession): boolean {
  return session.kind === 't3-thread' && session.backing !== undefined;
}

function activityTime(session: DiscoveredSession): number {
  return session.lastActivityAt ? Date.parse(session.lastActivityAt) : 0;
}

/**
 * Which of two sessions sharing an id is kept. A T3 Code thread backed by a
 * native record carries that record's id, so it and the Codex, Claude, or
 * OpenCode session found on its own are one conversation: the T3 thread wins,
 * since its title and project are the ones the user knows. Two T3 threads
 * pointing at one record keep the newer. Otherwise the first seen is kept.
 */
export function preferredSession(
  existing: DiscoveredSession,
  incoming: DiscoveredSession,
): DiscoveredSession {
  const existingT3 = isBackedT3Session(existing);
  const incomingT3 = isBackedT3Session(incoming);
  if (existingT3 && incomingT3) {
    const newer = activityTime(incoming) - activityTime(existing);
    if (newer !== 0) return newer > 0 ? incoming : existing;
    return compareText(incoming.storeId ?? '', existing.storeId ?? '') < 0
      ? incoming
      : existing;
  }
  return incomingT3 && !existingT3 ? incoming : existing;
}

function mergeRootInto(target: WorkingCandidate, root: DiscoveredRoot): void {
  // A folder the user picked is not evidence of any provider; merging its
  // placeholder provider would paint a phantom Claude badge on a Codex root.
  if (
    root.surface !== 'custom-folder' &&
    root.surface !== 'nested-repository'
  ) {
    target.providers.add(root.provider);
  }
  for (const surface of root.surfaces ?? [root.surface]) {
    target.surfaces.add(surface);
  }
  if (root.displayName && !target.displayName) {
    target.displayName = root.displayName;
  }
  target.lastActivityAt = laterIso(target.lastActivityAt, root.lastActivityAt);
  for (const session of root.sessions) mergeSessionInto(target, session);
}

function isProviderManagedWorktree(candidate: string): boolean {
  return candidate.includes(`${path.sep}.claude${path.sep}worktrees`);
}

function isExcluded(candidate: string, ctx: NormalizeContext): boolean {
  if (ctx.excludedExact.includes(candidate)) return true;
  if (path.parse(candidate).root === candidate) return true;
  if (isProviderManagedWorktree(candidate)) return true;
  return ctx.excludedRoots.some((root) => isPathInside(root, candidate));
}

function setToSortedArray<T extends string>(values: Set<T>): T[] {
  const out: T[] = [];
  values.forEach((value) => out.push(value));
  return out.sort();
}

/**
 * Newest first; `key` breaks ties so rows without activity (registry-only
 * folders, undated sessions) keep one order across scans instead of the
 * order the adapters happened to finish in.
 */
function sortByActivityDesc<T extends { lastActivityAt: string | null }>(
  items: T[],
  key: (item: T) => string,
): T[] {
  return [...items].sort((a, b) => {
    const at = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0;
    const bt = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0;
    return bt - at || compareText(key(a), key(b));
  });
}

/**
 * Adapters run concurrently and report in either order, and the present-root
 * merge keeps the first non-empty name it sees, so the roots are put in one
 * order before grouping: a folder both providers name gets the same name on
 * every scan.
 */
function inStableOrder(roots: readonly DiscoveredRoot[]): DiscoveredRoot[] {
  return [...roots].sort(
    (a, b) =>
      compareText(a.rootPath, b.rootPath) ||
      compareText(a.provider, b.provider) ||
      compareText(a.surface, b.surface),
  );
}

function isSessionScratchRoot(
  rootPath: string,
  ctx: NormalizeContext,
): boolean {
  return ctx.sessionScratchRoots.some((root) => isPathInside(root, rootPath));
}

/**
 * Title of the newest titled session. Callers pass native sessions only:
 * a chat Canopy itself ran in a folder says nothing about what the user
 * called it, and both the present and the missing-folder paths must agree
 * on what may name a candidate.
 */
function newestTitledSessionTitle(
  sessions: DiscoveredSession[],
): string | null {
  for (const session of sortByActivityDesc(sessions, (s) => s.id)) {
    const title = session.title?.trim();
    if (title) return title;
  }
  return null;
}

/** The last `segments` folders of a path, joined with `/`. */
function pathTail(rootPath: string, segments: number): string {
  const parts = rootPath.split(/[\\/]+/).filter(Boolean);
  return parts.slice(-segments).join('/');
}

/**
 * The name a candidate is shown by. A provider-assigned project name wins
 * and is kept exactly as written. A provider's per-session scratch folder
 * has no identity of its own, so it takes the title of its newest titled
 * chat, or at least its parent folder for context. Everything else is the
 * folder name, widened by {@link disambiguateDisplayNames} when it repeats.
 */
function resolveDisplayName(
  rootPath: string,
  providerName: string | null | undefined,
  sessions: DiscoveredSession[],
  ctx: NormalizeContext,
): { displayName: string; nameSource: DisplayNameSource } {
  if (providerName)
    return { displayName: providerName, nameSource: 'provider' };
  if (isSessionScratchRoot(rootPath, ctx)) {
    const title = newestTitledSessionTitle(sessions);
    if (title) return { displayName: title, nameSource: 'session' };
    return { displayName: pathTail(rootPath, 2), nameSource: 'path' };
  }
  return { displayName: path.basename(rootPath), nameSource: 'path' };
}

/**
 * Folder names repeat (`notes`, `app`, `outputs`), and a list of identical
 * rows is what made the picker unusable. Path-derived names that collide
 * grow by one parent folder at a time until distinct, bounded so a deep tree
 * never turns into a full path (the row shows the path anyway). Names the
 * source wrote, and chat titles, are left as they are: two chats really can
 * share a title.
 */
function disambiguateDisplayNames(named: NamedCandidate[]): void {
  for (let segments = 2; segments <= MAX_DISPLAY_NAME_SEGMENTS; segments += 1) {
    const groups = new Map<string, NamedCandidate[]>();
    for (const entry of named) {
      const key = entry.candidate.displayName.trim().toLowerCase();
      const group = groups.get(key);
      if (group) group.push(entry);
      else groups.set(key, [entry]);
    }
    // Every width runs even when a pass changes nothing: scratch names
    // already start two folders wide, so their first pass is a no-op and
    // only the next width can tell them apart.
    groups.forEach((group) => {
      if (group.length < 2) return;
      for (const entry of group) {
        if (entry.nameSource !== 'path') continue;
        entry.candidate.displayName = pathTail(
          entry.candidate.rootPath,
          segments,
        );
      }
    });
  }
}

function sessionSummary(
  session: DiscoveredSession,
  importedChatIds: Record<string, ExternalProjectImportedSession>,
): ExternalProjectSessionSummary {
  const imported = findImportedSession(importedChatIds, session);
  const t3Thread = session.kind === 't3-thread';
  const tier: ExternalProjectSessionSummary['tier'] = session.backing
    ? 'native'
    : 'history';
  // Native means a real user session the import may bring in; only Codex and
  // Claude records can keep the conversation going in Canopy. OpenCode
  // sessions and T3's own text copies arrive as read-only history.
  const backingContinues =
    session.backing?.provider === 'codex' ||
    session.backing?.provider === 'claude';
  const historyOnly =
    session.kind === 'opencode-session' || (t3Thread && !backingContinues);
  return {
    id: session.id,
    provider: session.provider,
    title: session.title,
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt,
    continuable: session.native && !historyOnly,
    ...(imported ? { importedChatId: imported.chatId } : {}),
    sizeBytes: session.sizeBytes,
    ...(t3Thread ? { tier } : {}),
    ...(session.backing ? { backingProvider: session.backing.provider } : {}),
    ...(session.archived !== undefined ? { archived: session.archived } : {}),
  };
}

interface GitLookup {
  value: string | null;
  complete: boolean;
}

/** Memoized filesystem and git lookups shared across one normalization run. */
class RootResolver {
  private readonly realpathCache = new Map<string, Promise<string | null>>();
  private readonly topLevelCache = new Map<string, Promise<GitLookup>>();
  private readonly commonDirCache = new Map<string, Promise<GitLookup>>();
  private readonly nestedCache = new Map<
    string,
    Promise<NestedRepositoryScan>
  >();

  constructor(private readonly deps: NormalizeDeps) {}

  /** Canonical directory path, or `null` when missing or not a directory. */
  canonicalize(candidate: string): Promise<string | null> {
    let pending = this.realpathCache.get(candidate);
    if (!pending) {
      pending = (async (): Promise<string | null> => {
        try {
          const real = await this.deps.realpath(candidate);
          return (await this.deps.isDirectory(real)) ? real : null;
        } catch {
          return null;
        }
      })();
      this.realpathCache.set(candidate, pending);
    }
    return pending;
  }

  topLevel(directory: string): Promise<GitLookup> {
    let pending = this.topLevelCache.get(directory);
    if (!pending) {
      pending = this.deps.gitTopLevel(directory).then(
        (value) => ({ value, complete: true }),
        () => ({ value: null, complete: false }),
      );
      this.topLevelCache.set(directory, pending);
    }
    return pending;
  }

  commonDir(topLevel: string): Promise<GitLookup> {
    let pending = this.commonDirCache.get(topLevel);
    if (!pending) {
      pending = this.deps.gitCommonDir(topLevel).then(
        (value) => ({ value, complete: value !== null }),
        () => ({ value: null, complete: false }),
      );
      this.commonDirCache.set(topLevel, pending);
    }
    return pending;
  }

  nested(directory: string): Promise<NestedRepositoryScan> {
    let pending = this.nestedCache.get(directory);
    if (!pending) {
      pending = Promise.resolve()
        .then(() => this.deps.findNestedRepositories(directory))
        .catch(() => ({ repositories: [], complete: false }));
      this.nestedCache.set(directory, pending);
    }
    return pending;
  }
}

/** Groups roots into working candidates, folding repository families. */
class CandidateGrouper {
  readonly byRoot = new Map<string, WorkingCandidate>();
  private readonly byCommonDir = new Map<string, WorkingCandidate>();
  readonly unavailable = new Map<string, UnavailableRoot>();
  private readonly pickedFolders = new Map<string, WorkingCandidate>();

  constructor(
    private readonly ctx: NormalizeContext,
    private readonly resolver: RootResolver,
  ) {}

  async add(root: DiscoveredRoot): Promise<void> {
    const canonical = await this.resolver.canonicalize(root.rootPath);
    if (!canonical) {
      // A folder that no longer exists cannot be canonicalized, so judge the
      // exclusion on the recorded path: a deleted worktree under the data
      // dir is still Canopy's own footprint, not a project to recover.
      if (!isExcluded(path.resolve(root.rootPath), this.ctx)) {
        this.recordUnavailable(root);
      }
      return;
    }
    if (isExcluded(canonical, this.ctx)) return;

    const lookup = await this.resolver.topLevel(canonical);
    const topLevel = lookup.value
      ? await this.resolver.canonicalize(lookup.value)
      : null;
    if (!topLevel) {
      const folder = this.folderCandidate(canonical);
      folder.listed = true;
      mergeRootInto(folder, root);
      if (root.surface === 'custom-folder') {
        if (lookup.complete && lookup.value === null) {
          this.pickedFolders.set(canonical, folder);
        } else {
          folder.nestedRepositories = { count: 0, complete: false };
        }
      }
      return;
    }
    if (isExcluded(topLevel, this.ctx)) return;

    const { value: commonDir } = await this.resolver.commonDir(topLevel);
    const target = await this.repositoryCandidate(topLevel, commonDir);
    if (!target) return;
    target.listed = true;
    mergeRootInto(target, root);
  }

  /** Resolve every marker before counting or capping, reusing the request caches. */
  async addNestedRepositories(): Promise<void> {
    for (const [canonical, parent] of this.pickedFolders) {
      const scan = await this.resolver.nested(canonical);
      let complete = scan.complete;
      const confirmed = new Set<WorkingCandidate>();
      for (const markerPath of scan.repositories) {
        const directory = await this.resolver.canonicalize(markerPath);
        if (!directory) {
          complete = false;
          continue;
        }
        if (isExcluded(directory, this.ctx)) continue;
        const lookup = await this.resolver.topLevel(directory);
        if (!lookup.complete) complete = false;
        if (!lookup.value) continue;
        const topLevel = await this.resolver.canonicalize(lookup.value);
        if (!topLevel) {
          complete = false;
          continue;
        }
        if (isExcluded(topLevel, this.ctx)) continue;
        const common = await this.resolver.commonDir(topLevel);
        if (!common.complete) {
          complete = false;
          continue;
        }
        const target = await this.repositoryCandidate(topLevel, common.value);
        if (!target) continue;
        confirmed.add(target);
        target.parentCandidateIds.add(externalProjectCandidateId(canonical));
      }
      parent.nestedRepositories = { count: confirmed.size, complete };
      const sorted = Array.from(confirmed).sort((a, b) =>
        compareText(a.rootPath, b.rootPath),
      );
      for (const target of sorted.slice(
        0,
        this.ctx.maxNestedRepositoriesListed,
      )) {
        target.listed = true;
        target.surfaces.add('nested-repository');
      }
    }
  }

  private recordUnavailable(root: DiscoveredRoot): void {
    // A missing folder only matters when it still holds chats the user
    // could recover; registry-only entries for deleted folders are noise.
    const nativeSessions = root.sessions.filter((session) => session.native);
    const nativeSessionCount = nativeSessions.length;
    if (nativeSessionCount === 0) return;
    // A missing folder cannot be canonicalized on disk, so its recorded path
    // is normalized (`.`, `..`, a trailing separator) once, here, and that
    // one form groups it, names it, ids it, and is widened if the name
    // repeats: two spellings of one folder never become two rows with one id.
    const rootPath = path.resolve(root.rootPath);
    const existing = this.unavailable.get(rootPath);
    if (existing) {
      // Both providers can report the same missing folder; keep both.
      existing.providers.add(root.provider);
      for (const surface of root.surfaces ?? [root.surface]) {
        existing.surfaces.add(surface);
      }
      existing.sessions.push(...nativeSessions);
      // Adapters finish in any order; a name must not depend on which
      // provider reported the folder first. Truthiness, like the present-root
      // merge, so an empty name never counts as one.
      existing.displayName ??= root.displayName || null;
      existing.nativeSessionCount += nativeSessionCount;
      existing.lastActivityAt = laterIso(
        existing.lastActivityAt,
        root.lastActivityAt,
      );
      return;
    }
    this.unavailable.set(rootPath, {
      rootPath,
      providers: new Set([root.provider]),
      surfaces: new Set(root.surfaces ?? [root.surface]),
      sessions: nativeSessions,
      displayName: root.displayName || null,
      nativeSessionCount,
      reason: MISSING_FOLDER_REASON,
      lastActivityAt: root.lastActivityAt,
    });
  }

  private folderCandidate(canonical: string): WorkingCandidate {
    const existing = this.byRoot.get(canonical);
    if (existing) return existing;
    const created = newWorkingCandidate(canonical, 'folder', null);
    this.byRoot.set(canonical, created);
    return created;
  }

  /**
   * The candidate that represents a repository top level. Linked worktrees
   * fold into the family keyed by the git common directory, preferring the
   * main checkout as the family root when it exists and is not excluded.
   */
  private async repositoryCandidate(
    topLevel: string,
    commonDir: string | null,
  ): Promise<WorkingCandidate | null> {
    let target = this.byRoot.get(topLevel) ?? null;
    if (!target && commonDir) {
      target = this.familyCandidate(topLevel, commonDir);
    }
    if (!target && commonDir) {
      target = await this.mainCheckoutCandidate(topLevel, commonDir);
    }
    if (!target) {
      target = newWorkingCandidate(topLevel, 'git', commonDir);
      this.byRoot.set(topLevel, target);
    }
    if (commonDir && !this.byCommonDir.has(commonDir)) {
      this.byCommonDir.set(commonDir, target);
    }
    return target;
  }

  private familyCandidate(
    topLevel: string,
    commonDir: string,
  ): WorkingCandidate | null {
    const family = this.byCommonDir.get(commonDir);
    if (!family) return null;
    if (family.rootPath !== topLevel) family.linkedWorktreePaths.add(topLevel);
    return family;
  }

  private async mainCheckoutCandidate(
    topLevel: string,
    commonDir: string,
  ): Promise<WorkingCandidate | null> {
    const mainCheckout = path.dirname(commonDir);
    const isLinkedWorktree =
      path.basename(commonDir) === '.git' && mainCheckout !== topLevel;
    if (!isLinkedWorktree) return null;
    const canonicalMain = await this.resolver.canonicalize(mainCheckout);
    if (!canonicalMain || isExcluded(canonicalMain, this.ctx)) return null;
    const target =
      this.byRoot.get(canonicalMain) ??
      newWorkingCandidate(canonicalMain, 'git', commonDir);
    this.byRoot.set(canonicalMain, target);
    target.linkedWorktreePaths.add(topLevel);
    return target;
  }
}

function statusAgainstWorkspace(
  working: WorkingCandidate,
  workspace: ExistingWorkspaceIdentity,
): CandidateStatus | null {
  const exact = workspace.rootPaths.some(
    (rootPath) => rootPath === working.rootPath,
  );
  const sameRepo =
    working.gitCommonDir !== null &&
    workspace.gitCommonDirs.includes(working.gitCommonDir);
  if (exact || sameRepo) {
    return {
      status: 'already-tracked',
      statusReason: exact
        ? `Already in your projects as "${workspace.name}"`
        : `Same repository as "${workspace.name}"`,
      trackedWorkspaceId: workspace.id,
    };
  }
  if (
    workspace.rootPaths.some((rootPath) =>
      isPathInside(rootPath, working.rootPath),
    )
  ) {
    return {
      status: 'already-tracked',
      statusReason: `Inside your project "${workspace.name}"`,
      trackedWorkspaceId: workspace.id,
    };
  }
  if (
    workspace.rootPaths.some((rootPath) =>
      isPathInside(working.rootPath, rootPath),
    )
  ) {
    return {
      status: 'unavailable',
      statusReason: `Contains your project "${workspace.name}", so it cannot be added as one project`,
    };
  }
  return null;
}

function resolveStatus(
  candidateId: string,
  working: WorkingCandidate,
  ctx: NormalizeContext,
): CandidateStatus {
  const ledgerEntry = ctx.ledger.imports[candidateId];
  const ledgerWorkspace = ledgerEntry
    ? ctx.existingWorkspaces.find(
        (workspace) => workspace.id === ledgerEntry.workspaceId,
      )
    : undefined;
  if (ledgerWorkspace) {
    return {
      status: 'already-imported',
      statusReason: `Imported earlier as "${ledgerWorkspace.name}"`,
      trackedWorkspaceId: ledgerWorkspace.id,
    };
  }
  for (const workspace of ctx.existingWorkspaces) {
    const status = statusAgainstWorkspace(working, workspace);
    if (status) return status;
  }
  return { status: 'available' };
}

function toCandidate(
  working: WorkingCandidate,
  ctx: NormalizeContext,
): NamedCandidate & { nativeSessionIds: string[] } {
  const id = externalProjectCandidateId(working.rootPath);
  const status = resolveStatus(id, working, ctx);
  const importedSessions = ctx.ledger.imports[id]?.sessions ?? {};
  const rawSessions: DiscoveredSession[] = [];
  working.sessions.forEach((session) => rawSessions.push(session));
  const nativeSessions = sortByActivityDesc(
    rawSessions.filter((session) => session.native),
    (session) => session.id,
  );
  const summaries = nativeSessions.map((session) =>
    sessionSummary(session, importedSessions),
  );
  const { displayName, nameSource } = resolveDisplayName(
    working.rootPath,
    working.displayName,
    nativeSessions,
    ctx,
  );
  return {
    nameSource,
    candidate: {
      id,
      providers: setToSortedArray(working.providers),
      surfaces: setToSortedArray(working.surfaces),
      displayName,
      rootPath: working.rootPath,
      kind: working.kind,
      ...status,
      linkedWorktreePaths: setToSortedArray(working.linkedWorktreePaths),
      lastActivityAt: working.lastActivityAt,
      sessions: summaries.slice(0, ctx.maxSessionsPerCandidate),
      sessionCount: summaries.length,
      importableSessionCount: summaries.filter(
        (session) => session.importedChatId === undefined,
      ).length,
      ...(working.nestedRepositories
        ? { nestedRepositories: working.nestedRepositories }
        : {}),
      ...(working.parentCandidateIds.size > 0
        ? { parentCandidateIds: setToSortedArray(working.parentCandidateIds) }
        : {}),
    },
    nativeSessionIds: nativeSessions.map((session) => session.id),
  };
}

function toUnavailableCandidate(
  entry: UnavailableRoot,
  ctx: NormalizeContext,
): NamedCandidate {
  const { rootPath, reason } = entry;
  const { displayName, nameSource } = resolveDisplayName(
    rootPath,
    entry.displayName,
    entry.sessions,
    ctx,
  );
  return {
    nameSource,
    candidate: {
      id: externalProjectCandidateId(rootPath),
      providers: setToSortedArray(entry.providers),
      surfaces: setToSortedArray(entry.surfaces),
      displayName,
      rootPath,
      kind: 'folder',
      status: 'unavailable',
      statusReason: reason,
      linkedWorktreePaths: [],
      lastActivityAt: entry.lastActivityAt,
      sessions: [],
      sessionCount: entry.nativeSessionCount,
      importableSessionCount: 0,
    },
  };
}

export async function normalizeDiscoveredRoots(
  roots: DiscoveredRoot[],
  ctx: NormalizeContext,
  deps: NormalizeDeps,
): Promise<NormalizeResult> {
  const grouper = new CandidateGrouper(ctx, new RootResolver(deps));
  for (const root of inStableOrder(roots)) await grouper.add(root);
  await grouper.addNestedRepositories();

  const named: NamedCandidate[] = [];
  const nativeSessionIdsByCandidate = new Map<string, string[]>();
  grouper.byRoot.forEach((working) => {
    if (!working.listed) return;
    const { candidate, nameSource, nativeSessionIds } = toCandidate(
      working,
      ctx,
    );
    named.push({ candidate, nameSource });
    nativeSessionIdsByCandidate.set(candidate.id, nativeSessionIds);
  });

  const unavailableEntries: UnavailableRoot[] = [];
  grouper.unavailable.forEach((entry) => unavailableEntries.push(entry));
  const unavailableList = sortByActivityDesc(
    unavailableEntries,
    (entry) => entry.rootPath,
  );
  for (const entry of unavailableList.slice(0, ctx.maxUnavailableCandidates)) {
    named.push(toUnavailableCandidate(entry, ctx));
  }
  // Over the shown set as a whole: a present and a missing `notes` collide
  // on screen just the same.
  disambiguateDisplayNames(named);
  const candidates = named.map((entry) => entry.candidate);

  const diagnostics: DiscoveryDiagnostic[] = [];
  const hiddenUnavailable =
    unavailableList.length - ctx.maxUnavailableCandidates;
  if (hiddenUnavailable > 0) {
    diagnostics.push({
      source: 'discovery',
      message: `${hiddenUnavailable} more folders with chats no longer exist and were left out.`,
    });
  }

  return {
    candidates: sortByActivityDesc(
      candidates,
      (candidate) => candidate.rootPath,
    ),
    diagnostics,
    nativeSessionIdsByCandidate,
  };
}
