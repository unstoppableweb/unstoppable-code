import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type {
  OrgProjectPreference,
  OrgProjectSummary,
} from '@canopy/protocol/org-projects';
import {
  isOrgProjectCatalogResponse,
  isOrgProjectSummary,
  isRefreshOrgProjectRepositoriesResponse,
} from '@canopy/protocol/org-projects';
import {
  isSameWorkspaceContext,
  serializeWorkspaceContext,
  IPC_CHANNELS,
  type DesktopOrgProjectCatalogSnapshot,
  type OrgProjectCatalogError,
  type WorkspaceContext,
} from '@canopy/desktop-shared/types';
import {
  CanopyCloudClientError,
  requestCanopyCloudJson,
  requestCanopyCloudJsonConditional,
} from '../canopy-cloud/client';
import { writeFileAtomically } from '../lib/atomic-file';
import {
  getCanopyCloudCredentials,
  readCanopyCloudAccountWithStatus,
  subscribeCanopyCloudAccountChanges,
  type CanopyCloudAccountEntry,
} from '../lib/canopy-cloud-account-store';
import { getOrgProjectCatalogDir } from '../lib/paths';
import { getWorkspaceContextService } from '../lib/workspace-context-service';
import { getInstallId } from '../lib/install-identity';
import { readAllSidebarItems } from '../lib/sidebar-items';
import { recordOrganizationPrivateMemory } from '../lib/workspace-private-memory';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { sendToAllWindows } from '../lib/window-send';
import {
  detachedWorkCallback,
  trackDetachedWork,
} from '@canopy/desktop-shared/node/lib/detached-work';

export type { DesktopOrgProjectCatalogSnapshot } from '@canopy/desktop-shared/types';

type RepositoriesRefreshResult = NonNullable<
  DesktopOrgProjectCatalogSnapshot['repositoriesRefresh']
> | null;

/** Server capability that unlocks the catalog routes. */
export const ORG_PROJECTS_CAPABILITY = 'org-projects-v1';
/** A cached catalog older than this is refreshed on the next read. */
export const ORG_PROJECT_CATALOG_MAX_AGE_MS = 10 * 60 * 1000;
/** Background refresh cadence while the app runs. */
export const ORG_PROJECT_CATALOG_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
/**
 * How long a refresh waits for the server to re-read the organization's
 * repositories from GitHub (CAN-3489). The server answers `timed-out` after
 * its own 8-second time box, so this only covers a server that never answers.
 */
export const ORG_PROJECT_REPOSITORY_REFRESH_TIMEOUT_MS = 12_000;

export interface OrgProjectCatalogRefreshOptions {
  /** Fetch without `If-None-Match`. */
  force?: boolean;
  /**
   * First ask the server to re-read the organization's repositories from
   * GitHub (the Add project dialog opening, CAN-3489); implies `force`.
   */
  repositories?: boolean;
}
const CATALOG_FILE_VERSION = 1;

interface CatalogFile {
  version: typeof CATALOG_FILE_VERSION;
  revision: string;
  projects: OrgProjectSummary[];
  fetchedAt: string;
  /** Null for merged catalogs and legacy files with unknown pagination. */
  etag: string | null;
}

interface CatalogEntry {
  /**
   * Null until the context has an answer: a fetch, the disk cache, or a
   * failure. An in-flight first fetch has nothing to show, and must not pass
   * off an empty list as the catalog: the same-repository resolver would read
   * it as "nothing is linked" and flip on-disk repositories to setup rows
   * (CAN-3388).
   */
  snapshot: DesktopOrgProjectCatalogSnapshot | null;
  /** ETag of the first page of the last successful fetch, for `If-None-Match`. */
  etag: string | null;
  inFlight: Promise<DesktopOrgProjectCatalogSnapshot> | null;
}

export interface OrgProjectCatalogService {
  initialize(): Promise<void>;
  /** The cached snapshot for a context; refreshes in the background when stale. */
  list(context: WorkspaceContext): Promise<DesktopOrgProjectCatalogSnapshot>;
  /**
   * The in-memory snapshot for a context, or `null` while it has no answer yet
   * (including during its first fetch). Unlike `list`, this
   * neither refreshes a stale entry nor clears an unavailable one, so it never
   * broadcasts. Readers that are themselves driven by the broadcast — the
   * desktop session snapshot — must use this, or they and the catalog keep
   * waking each other up.
   */
  peek(context: WorkspaceContext): DesktopOrgProjectCatalogSnapshot | null;
  /** Fetch the context now; `force` ignores the conditional request. */
  refresh(
    context: WorkspaceContext,
    options?: OrgProjectCatalogRefreshOptions,
  ): Promise<DesktopOrgProjectCatalogSnapshot>;
  setPreference(
    context: WorkspaceContext,
    projectId: string,
    preference: OrgProjectPreference,
  ): Promise<DesktopOrgProjectCatalogSnapshot>;
  subscribe(
    listener: (snapshot: DesktopOrgProjectCatalogSnapshot) => void,
  ): () => void;
  dispose(): void;
}

/** Windows-safe file name for a serialized context. */
export function contextFileName(context: WorkspaceContext): string {
  return context.kind === 'personal'
    ? 'personal'
    : `organization-${context.organizationId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeCatalogFile(value: unknown): CatalogFile | null {
  if (
    !isRecord(value) ||
    value.version !== CATALOG_FILE_VERSION ||
    typeof value.revision !== 'string' ||
    typeof value.fetchedAt !== 'string' ||
    !Array.isArray(value.projects)
  ) {
    return null;
  }
  const projects = value.projects.filter(isOrgProjectSummary);
  return {
    version: CATALOG_FILE_VERSION,
    revision: value.revision,
    projects,
    fetchedAt: value.fetchedAt,
    etag: typeof value.etag === 'string' ? value.etag : null,
  };
}

function emptySnapshot(
  context: WorkspaceContext,
  error: OrgProjectCatalogError | null,
): DesktopOrgProjectCatalogSnapshot {
  return {
    context: serializeWorkspaceContext(context),
    revision: '',
    projects: [],
    fetchedAt: new Date(0).toISOString(),
    stale: error !== null,
    error,
  };
}

/**
 * The snapshot with its GitHub re-read mark set or dropped. The mark describes
 * one refresh, so every other answer is built without it.
 */
function markRepositoriesRefresh(
  snapshot: DesktopOrgProjectCatalogSnapshot,
  result: RepositoriesRefreshResult,
): DesktopOrgProjectCatalogSnapshot {
  const unmarked: DesktopOrgProjectCatalogSnapshot = {
    context: snapshot.context,
    revision: snapshot.revision,
    projects: snapshot.projects,
    fetchedAt: snapshot.fetchedAt,
    stale: snapshot.stale,
    error: snapshot.error,
  };
  return result === null
    ? unmarked
    : { ...unmarked, repositoriesRefresh: result };
}

function classifyError(error: unknown): OrgProjectCatalogError {
  if (error instanceof CanopyCloudClientError) {
    if (error.code === 'unsupported-capability') return 'unavailable';
    if (error.status === 403 || error.status === 404) return 'access-changed';
  }
  return 'offline';
}

export function createOrgProjectCatalogService(): OrgProjectCatalogService {
  const entries = new Map<string, CatalogEntry>();
  const requestGenerations = new Map<string, number>();
  const commitQueues = new Map<string, Promise<void>>();
  const listeners = new Set<
    (snapshot: DesktopOrgProjectCatalogSnapshot) => void
  >();
  let accountId: string | null = null;
  let accountReadDegraded = false;
  let accountGeneration = 0;
  let deviceId: string | null = null;
  let unsubscribeAccount: (() => void) | null = null;
  let unsubscribeFlags: (() => void) | null = null;
  let rolloutEnabled = isRolloutEnabled();
  let rolloutGeneration = 0;
  let unsubscribeContext: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let initialized: Promise<void> | null = null;
  let accountAdoptions: Promise<void> = Promise.resolve();

  function isRolloutEnabled(): boolean {
    return getFeatureFlagService().isEnabled(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
    );
  }

  function syncPolling(): void {
    if (timer) clearInterval(timer);
    timer = null;
    if (!isRolloutEnabled()) return;
    timer = setInterval(
      detachedWorkCallback(() =>
        refresh(getWorkspaceContextService().getState().context),
      ),
      ORG_PROJECT_CATALOG_REFRESH_INTERVAL_MS,
    );
    timer.unref?.();
  }

  function accountKey(entry: CanopyCloudAccountEntry | null): string | null {
    const rawId = entry?.account?.id;
    const id = typeof rawId === 'string' ? rawId.trim() : null;
    if (!id || !/^[a-zA-Z0-9_.-]+$/.test(id) || id === '.' || id === '..')
      return null;
    try {
      accountDir(id);
      return id;
    } catch {
      return null;
    }
  }

  function accountDir(id: string): string {
    const root = getOrgProjectCatalogDir();
    const directory = join(root, id);
    const withinRoot = relative(root, directory);
    if (
      !withinRoot ||
      withinRoot === '..' ||
      withinRoot.startsWith(`..${sep}`) ||
      isAbsolute(withinRoot)
    ) {
      throw new Error('Invalid catalog account directory');
    }
    return directory;
  }

  function filePath(id: string, context: WorkspaceContext): string {
    return join(accountDir(id), `${contextFileName(context)}.json`);
  }

  function broadcast(snapshot: DesktopOrgProjectCatalogSnapshot): void {
    listeners.forEach((listener) => {
      listener(snapshot);
    });
  }

  async function reconcilePrivateMemory(
    snapshot: DesktopOrgProjectCatalogSnapshot,
  ): Promise<void> {
    if (snapshot.error !== null) return;
    const projects = new Map(
      snapshot.projects
        .filter(
          (project) =>
            project.organizationId !== null &&
            typeof project.privateMemory === 'boolean',
        )
        .map((project) => [project.id, project]),
    );
    if (projects.size === 0) return;
    const items = (await readAllSidebarItems()).items;
    for (const item of items) {
      const owner = item.owner;
      if (owner?.type !== 'organization') continue;
      const project = projects.get(owner.projectId);
      if (
        !project ||
        owner.organizationId !== project.organizationId ||
        typeof project.privateMemory !== 'boolean'
      )
        continue;
      const changed = await recordOrganizationPrivateMemory({
        workspaceId: item.id,
        organizationId: owner.organizationId,
        projectId: owner.projectId,
        privateMemory: project.privateMemory,
      }).catch((error: unknown): boolean => {
        logMainProcessWarn(
          '[org-projects] private memory reconciliation failed for workspace',
          { workspaceId: item.id, error },
        );
        return false;
      });
      if (changed) {
        sendToAllWindows(IPC_CHANNELS.workspacePrivateMemoryChanged, item.id);
      }
    }
  }

  function remember(
    key: string,
    snapshot: DesktopOrgProjectCatalogSnapshot,
    etag: string | null,
  ): void {
    const current = entries.get(key);
    const previous = current?.snapshot ?? null;
    const unchanged =
      previous !== null &&
      JSON.stringify(previous) === JSON.stringify(snapshot);
    entries.set(key, {
      snapshot,
      etag,
      inFlight: current?.inFlight ?? null,
    });
    // A repeated failure re-remembers the same unavailable or stale snapshot.
    // Announcing it again tells every subscriber something changed when
    // nothing did, and subscribers that re-read the catalog would keep the
    // exchange going.
    if (!unchanged) broadcast(snapshot);
  }

  function entryKey(context: WorkspaceContext, id = accountId): string {
    return JSON.stringify([id, serializeWorkspaceContext(context)]);
  }

  /** What a superseded request answers: the newer request's latest answer. */
  function settledSnapshot(
    key: string,
    context: WorkspaceContext,
  ): DesktopOrgProjectCatalogSnapshot {
    return (
      entries.get(key)?.snapshot ??
      emptySnapshot(context, accountId ? null : 'unavailable')
    );
  }

  async function readCached(
    id: string | null,
    context: WorkspaceContext,
  ): Promise<{ file: CatalogFile; etag: string | null } | null> {
    if (!id) return null;
    try {
      const raw = await readFile(filePath(id, context), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const file = normalizeCatalogFile(parsed);
      if (!file) return null;
      return { file, etag: file.etag };
    } catch {
      return null;
    }
  }

  async function persist(
    id: string,
    etag: string | null,
    context: WorkspaceContext,
    snapshot: DesktopOrgProjectCatalogSnapshot,
    isCurrent: () => boolean,
  ): Promise<void> {
    const file: CatalogFile = {
      version: CATALOG_FILE_VERSION,
      revision: snapshot.revision,
      projects: snapshot.projects,
      fetchedAt: snapshot.fetchedAt,
      etag,
    };
    const target = filePath(id, context);
    try {
      await mkdir(accountDir(id), { recursive: true });
      if (!isCurrent()) return;
      await writeFileAtomically(target, `${JSON.stringify(file, null, 2)}\n`, {
        mode: 0o600,
      });
    } catch {
      // Best effort: the in-memory snapshot remains authoritative.
    }
  }

  async function fetchCatalog(
    context: WorkspaceContext,
    etag: string | null,
    isCurrent: () => boolean,
  ): Promise<
    | {
        kind: 'fresh';
        snapshot: DesktopOrgProjectCatalogSnapshot;
        etag: string | null;
      }
    | { kind: 'not-modified' }
  > {
    const credentials = await getCanopyCloudCredentials();
    if (!isCurrent()) return { kind: 'not-modified' };
    if (!credentials.capabilities.includes(ORG_PROJECTS_CAPABILITY)) {
      throw new CanopyCloudClientError(
        'unsupported-capability',
        'Organization projects are not available on this server.',
      );
    }
    const query = new URLSearchParams({
      context: serializeWorkspaceContext(context),
    });
    if (deviceId) query.set('deviceId', deviceId);
    const base = `/api/v1/projects/catalog`;
    const first = await requestCanopyCloudJsonConditional<unknown>(
      `${base}?${query.toString()}`,
      { etag, credentialContext: credentials },
    );
    if (first.status === 'not-modified') {
      return { kind: 'not-modified' };
    }
    if (!isOrgProjectCatalogResponse(first.body)) {
      throw new CanopyCloudClientError(
        'invalid-response',
        'The catalog response was not understood.',
      );
    }
    const projects = [...first.body.data];
    let cursor = first.body.nextCursor;
    let pages = 1;
    const cursors = new Set<string>();
    while (cursor !== null) {
      if (!isCurrent()) return { kind: 'not-modified' };
      if (cursors.has(cursor)) {
        throw new CanopyCloudClientError(
          'invalid-response',
          'The catalog pagination did not complete.',
        );
      }
      cursors.add(cursor);
      query.set('cursor', cursor);
      const page = await requestCanopyCloudJson<unknown>(
        `${base}?${query.toString()}`,
        { credentialContext: credentials },
      );
      if (!isOrgProjectCatalogResponse(page)) {
        throw new CanopyCloudClientError(
          'invalid-response',
          'The catalog response was not understood.',
        );
      }
      projects.push(...page.data);
      cursor = page.nextCursor;
      pages += 1;
    }
    return {
      kind: 'fresh',
      etag: pages === 1 ? first.etag : null,
      snapshot: {
        context: serializeWorkspaceContext(context),
        revision: first.body.revision,
        projects,
        fetchedAt: new Date().toISOString(),
        stale: false,
        error: null,
      },
    };
  }

  /**
   * Ask the server to re-read the organization's repositories from GitHub
   * (CAN-3489). Distinguishes a confirmed missing connection from a failed,
   * timed-out, or malformed answer. Null means no transient mark; it is not
   * proof of connectivity, since older servers (404) and unsupported
   * capabilities also return it.
   */
  async function refreshRepositories(
    context: WorkspaceContext,
    isCurrent: () => boolean,
  ): Promise<RepositoriesRefreshResult> {
    if (context.kind !== 'organization') return null;
    try {
      const credentials = await getCanopyCloudCredentials();
      // The catalog fetch reports a missing capability itself.
      if (
        !isCurrent() ||
        !credentials.capabilities.includes(ORG_PROJECTS_CAPABILITY)
      )
        return null;
      const answer = await requestCanopyCloudJson<unknown>(
        '/api/v1/projects/repositories/refresh',
        {
          method: 'POST',
          credentialContext: credentials,
          timeoutMs: ORG_PROJECT_REPOSITORY_REFRESH_TIMEOUT_MS,
          body: JSON.stringify({ organizationId: context.organizationId }),
        },
      );
      if (!isRefreshOrgProjectRepositoriesResponse(answer)) return 'failed';
      if (answer.status === 'not-connected') return 'not-connected';
      return answer.status === 'failed' || answer.status === 'timed-out'
        ? 'failed'
        : null;
    } catch (error) {
      return error instanceof CanopyCloudClientError && error.status === 404
        ? null
        : 'failed';
    }
  }

  async function clearUnavailable(
    id: string,
    context: WorkspaceContext,
  ): Promise<DesktopOrgProjectCatalogSnapshot> {
    const key = entryKey(context, id);
    requestGenerations.set(key, (requestGenerations.get(key) ?? 0) + 1);
    const snapshot = emptySnapshot(context, 'unavailable');
    remember(key, snapshot, null);
    const commit = (commitQueues.get(key) ?? Promise.resolve()).then(
      async (): Promise<void> => {
        await rm(filePath(id, context), { force: true });
      },
    );
    const settled = commit.catch((): void => {});
    commitQueues.set(key, settled);
    try {
      await commit;
    } catch {
      // Best effort: capability checks also guard subsequent cache reads.
    } finally {
      if (commitQueues.get(key) === settled) commitQueues.delete(key);
    }
    return snapshot;
  }

  async function refreshNow(
    context: WorkspaceContext,
    options: OrgProjectCatalogRefreshOptions,
  ): Promise<DesktopOrgProjectCatalogSnapshot> {
    if (!isRolloutEnabled()) return emptySnapshot(context, 'unavailable');
    const flagGeneration = rolloutGeneration;
    if (!accountId && accountReadDegraded) {
      accountAdoptions = accountAdoptions
        .then(async (): Promise<void> => {
          if (accountId || !accountReadDegraded) return;
          const result = await readCanopyCloudAccountWithStatus();
          // An account write supersedes a pending storage read.
          if (!accountReadDegraded || result.status !== 'ok') return;
          accountReadDegraded = false;
          await adoptAccount(result.entry);
        })
        .catch((): void => {});
      await accountAdoptions;
      if (accountId) return refresh(context, options);
    }
    const id = accountId;
    const generation = accountGeneration;
    const key = entryKey(context, id);
    const requestGeneration = (requestGenerations.get(key) ?? 0) + 1;
    requestGenerations.set(key, requestGeneration);
    const current = entries.get(key);
    if (!id) {
      const snapshot = emptySnapshot(context, 'unavailable');
      remember(key, snapshot, null);
      return snapshot;
    }
    try {
      const repositoriesRefresh =
        options.repositories === true
          ? await refreshRepositories(
              context,
              (): boolean =>
                isRolloutEnabled() && flagGeneration === rolloutGeneration,
            )
          : null;
      const result = await fetchCatalog(
        context,
        options.force || options.repositories ? null : (current?.etag ?? null),
        (): boolean =>
          isRolloutEnabled() && flagGeneration === rolloutGeneration,
      );
      if (
        !isRolloutEnabled() ||
        flagGeneration !== rolloutGeneration ||
        generation !== accountGeneration
      )
        return emptySnapshot(context, 'unavailable');
      if (requestGeneration !== requestGenerations.get(key))
        return settledSnapshot(key, context);
      if (result.kind === 'not-modified' && !current?.snapshot) {
        // Nothing cached to keep: fetch unconditionally.
        return refreshNow(context, { force: true });
      }
      const snapshot = markRepositoriesRefresh(
        result.kind === 'fresh'
          ? result.snapshot
          : {
              ...(current?.snapshot ?? emptySnapshot(context, null)),
              fetchedAt: new Date().toISOString(),
              stale: false,
              error: null,
            },
        repositoriesRefresh,
      );
      const etag =
        result.kind === 'fresh' ? result.etag : (current?.etag ?? null);
      const isCurrent = (): boolean =>
        isRolloutEnabled() &&
        flagGeneration === rolloutGeneration &&
        generation === accountGeneration &&
        requestGeneration === requestGenerations.get(key);
      // Hold the context's queue through persistence so writes cannot overtake.
      const commit = (commitQueues.get(key) ?? Promise.resolve()).then(
        async (): Promise<void> => {
          if (!isCurrent()) return;
          await reconcilePrivateMemory(snapshot).catch((error: unknown) => {
            logMainProcessWarn(
              '[org-projects] private memory reconciliation failed',
              error,
            );
          });
          remember(key, snapshot, etag);
          if (!isCurrent()) return;
          await persist(id, etag, context, snapshot, isCurrent);
        },
      );
      const settled = commit.catch((): void => {});
      commitQueues.set(key, settled);
      try {
        await commit;
        if (!isCurrent()) await commitQueues.get(key);
      } finally {
        if (commitQueues.get(key) === settled) commitQueues.delete(key);
      }
      if (
        !isRolloutEnabled() ||
        flagGeneration !== rolloutGeneration ||
        generation !== accountGeneration
      )
        return emptySnapshot(context, 'unavailable');
      if (requestGeneration !== requestGenerations.get(key))
        return settledSnapshot(key, context);
      return snapshot;
    } catch (error) {
      if (
        !isRolloutEnabled() ||
        flagGeneration !== rolloutGeneration ||
        generation !== accountGeneration
      )
        return emptySnapshot(context, 'unavailable');
      if (requestGeneration !== requestGenerations.get(key))
        return settledSnapshot(key, context);
      const reason = classifyError(error);
      if (reason === 'unavailable') return clearUnavailable(id, context);
      // Read the entry again: `list()` may have loaded the disk cache while
      // this fetch was in flight, and a failure must keep it (marked stale)
      // rather than overwrite it with an empty catalog.
      const latest = entries.get(key)?.snapshot ? entries.get(key) : current;
      const snapshot: DesktopOrgProjectCatalogSnapshot = latest?.snapshot
        ? markRepositoriesRefresh(
            { ...latest.snapshot, stale: true, error: reason },
            null,
          )
        : emptySnapshot(context, reason);
      remember(key, snapshot, latest?.etag ?? null);
      return snapshot;
    }
  }

  function refresh(
    context: WorkspaceContext,
    options: OrgProjectCatalogRefreshOptions = {},
  ): Promise<DesktopOrgProjectCatalogSnapshot> {
    if (!isRolloutEnabled())
      return Promise.resolve(emptySnapshot(context, 'unavailable'));
    const key = entryKey(context);
    const current = entries.get(key);
    if (current?.inFlight && !options.force && !options.repositories) {
      return current.inFlight;
    }
    const run = refreshNow(context, options).finally(() => {
      const entry = entries.get(key);
      if (entry && entry.inFlight === run) {
        entry.inFlight = null;
      }
    });
    const latest = entries.get(key);
    entries.set(key, {
      snapshot: latest?.snapshot ?? null,
      etag: latest?.etag ?? null,
      inFlight: run,
    });
    return run;
  }

  async function list(
    context: WorkspaceContext,
  ): Promise<DesktopOrgProjectCatalogSnapshot> {
    if (!isRolloutEnabled()) return emptySnapshot(context, 'unavailable');
    const flagGeneration = rolloutGeneration;
    const id = accountId;
    const generation = accountGeneration;
    const key = entryKey(context, id);
    if (id) {
      let unavailable = false;
      try {
        const credentials = await getCanopyCloudCredentials();
        unavailable = !credentials.capabilities.includes(
          ORG_PROJECTS_CAPABILITY,
        );
      } catch (error) {
        unavailable = classifyError(error) === 'unavailable';
      }
      if (
        !isRolloutEnabled() ||
        flagGeneration !== rolloutGeneration ||
        generation !== accountGeneration
      )
        return emptySnapshot(context, 'unavailable');
      if (unavailable) return clearUnavailable(id, context);
    }
    let current = entries.get(key);
    if (!current?.snapshot) {
      const cached = await readCached(id, context);
      if (
        !isRolloutEnabled() ||
        flagGeneration !== rolloutGeneration ||
        generation !== accountGeneration
      )
        return emptySnapshot(context, 'unavailable');
      // An answer that landed during the read is newer than the file.
      const landed = entries.get(key);
      if (cached && !landed?.snapshot) {
        const snapshot: DesktopOrgProjectCatalogSnapshot = {
          context: serializeWorkspaceContext(context),
          revision: cached.file.revision,
          projects: cached.file.projects,
          fetchedAt: cached.file.fetchedAt,
          stale: false,
          error: null,
        };
        // Keep a first fetch that is already running; it still owns the entry.
        entries.set(key, {
          snapshot,
          etag: landed?.etag ?? cached.etag,
          inFlight: landed?.inFlight ?? null,
        });
        await reconcilePrivateMemory(snapshot).catch((error: unknown) => {
          logMainProcessWarn(
            '[org-projects] cached private memory reconciliation failed',
            error,
          );
        });
      }
      current = entries.get(key);
    }
    if (!current?.snapshot) {
      // Nothing to show yet: wait for the answer instead of an empty stand-in.
      return refresh(context);
    }
    const age = Date.now() - Date.parse(current.snapshot.fetchedAt);
    if (!Number.isFinite(age) || age > ORG_PROJECT_CATALOG_MAX_AGE_MS) {
      trackDetachedWork(() => refresh(context));
    }
    return current.snapshot;
  }

  async function purgeAccount(id: string | null): Promise<void> {
    entries.clear();
    requestGenerations.clear();
    if (!id) return;
    try {
      await rm(accountDir(id), { recursive: true, force: true });
    } catch {
      // Nothing to purge, or the directory is busy; the next sign-in rewrites it.
    }
  }

  async function adoptAccount(
    entry: CanopyCloudAccountEntry | null,
  ): Promise<void> {
    const next = accountKey(entry);
    if (next === accountId) return;
    const previous = accountId;
    accountId = next;
    accountGeneration += 1;
    await purgeAccount(previous);
    if (accountId) {
      trackDetachedWork(() =>
        refresh(getWorkspaceContextService().getState().context),
      );
    }
  }

  function handleRolloutChange(): void {
    const next = isRolloutEnabled();
    if (next === rolloutEnabled) return;
    rolloutEnabled = next;
    rolloutGeneration += 1;
    // Detach obsolete requests so re-enable can start a fresh refresh.
    entries.forEach((entry): void => {
      entry.inFlight = null;
    });
    syncPolling();
  }

  return {
    initialize(): Promise<void> {
      initialized ??= (async (): Promise<void> => {
        try {
          deviceId = await getInstallId();
        } catch {
          deviceId = null;
        }
        try {
          const result = await readCanopyCloudAccountWithStatus();
          accountReadDegraded = result.status !== 'ok';
          accountId = result.status === 'ok' ? accountKey(result.entry) : null;
        } catch {
          accountId = null;
          accountReadDegraded = true;
        }
        unsubscribeAccount = subscribeCanopyCloudAccountChanges(
          (entry): void => {
            accountReadDegraded = false;
            accountAdoptions = accountAdoptions
              .then((): Promise<void> => adoptAccount(entry))
              .catch((): void => {});
          },
        );
        unsubscribeContext = getWorkspaceContextService().subscribe((state) => {
          trackDetachedWork(() => refresh(state.context));
        });
        unsubscribeFlags =
          getFeatureFlagService().onSnapshotChanged(handleRolloutChange);
        handleRolloutChange();
        syncPolling();
      })();
      return initialized;
    },
    list,
    peek(context): DesktopOrgProjectCatalogSnapshot | null {
      if (!isRolloutEnabled()) return emptySnapshot(context, 'unavailable');
      return entries.get(entryKey(context))?.snapshot ?? null;
    },
    refresh,
    async setPreference(
      context,
      projectId,
      preference,
    ): Promise<DesktopOrgProjectCatalogSnapshot> {
      if (!isRolloutEnabled()) return emptySnapshot(context, 'unavailable');
      const flagGeneration = rolloutGeneration;
      const credentials = await getCanopyCloudCredentials();
      if (!isRolloutEnabled() || flagGeneration !== rolloutGeneration)
        return emptySnapshot(context, 'unavailable');
      await requestCanopyCloudJson<unknown>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/preference`,
        {
          method: 'PUT',
          credentialContext: credentials,
          body: JSON.stringify({
            preference,
            ...(deviceId ? { deviceId } : {}),
          }),
        },
      );
      return refresh(context, { force: true });
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    dispose(): void {
      unsubscribeAccount?.();
      unsubscribeContext?.();
      unsubscribeFlags?.();
      if (timer) clearInterval(timer);
      listeners.clear();
      entries.clear();
      requestGenerations.clear();
    },
  };
}

let singleton: OrgProjectCatalogService | null = null;

export function getOrgProjectCatalogService(): OrgProjectCatalogService {
  singleton ??= createOrgProjectCatalogService();
  return singleton;
}

/** Test seam. */
export function resetOrgProjectCatalogServiceForTests(): void {
  singleton?.dispose();
  singleton = null;
}

export function isSameContext(
  a: WorkspaceContext,
  b: WorkspaceContext,
): boolean {
  return isSameWorkspaceContext(a, b);
}
