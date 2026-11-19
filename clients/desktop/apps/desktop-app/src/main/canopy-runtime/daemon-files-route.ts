import {
  createBoundedReadEvidence,
  type ReadEvidenceCursor,
  type ReadEvidenceJournal,
  type ReadEvidenceSnapshot,
} from '@canopy/desktop-shared/lib/bounded-read-evidence';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import {
  CanopyClientError,
  type CanopyClientQueryOptions,
} from '@canopy/core-client';
import {
  CanopyOperationError,
  type CanopyHandlerContext,
} from '@canopy/core-runtime';
import {
  createFilesystemScopeResolver,
  filesystemScopeError,
  hasGitPathSegment,
  readNativeRootIdentity,
  readRootVisibility,
  requireFilesystemCatalogRevision,
  sortDirectoryEntries,
  withVerifiedFilesystemCatalog,
  type FilesystemFileRead,
  type FilesystemLinkResolved,
  type FilesystemRootCatalog,
  type FilesystemScopeDependencies,
  type FilesystemScopeResolver,
  type FilesystemSearchPage,
} from '@canopy/core-runtime/node';
import {
  CANOPY_IN_PROCESS_WORKER_TARGET_ID,
  WORKER_FILESYSTEM_FILE_READ_ERROR_CODES,
  WORKER_FILESYSTEM_LINK_RESOLVE_ERROR_CODES,
  WORKER_FILESYSTEM_SEARCH_ERROR_CODES,
  type CanopyCallerDescriptor,
  type CanopyErrorPayload,
  type CanopyWorkspaceScope,
  type WorkerFilesystemDirectoryListParams,
  type WorkerFilesystemDirectoryListResult,
  type WorkerFilesystemFileReadParams,
  type WorkerFilesystemFileReadResult,
  type WorkerFilesystemLinkResolveParams,
  type WorkerFilesystemLinkResolveResult,
  type WorkerFilesystemRootsListParams,
  type WorkerFilesystemRootsListResult,
  type WorkerFilesystemSearchParams,
  type WorkerFilesystemSearchResult,
} from '@canopy/protocol/canopy-core';
import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type FileTreeDirectoryResponse,
  type FileTreeRootsResponse,
  type WorkspaceType,
} from '@canopy/desktop-shared/types';
import type { BackgroundServiceUnreachableReason } from '@canopy/desktop-shared/lib/background-service-status';
import {
  recordFilesRouteOutcome,
  recordFilesRouteSelected,
} from '@canopy/desktop-shared/node/work-counters';
import { validateId, validateOptionalRepoId } from '../lib/validation';
import { normalizeFileTreeRelativePath } from '../services/file-tree-relative-path';
import {
  evaluateReadRoute,
  resolveReadRoutePlatform,
  type FilesReadRouteOperation,
  type ReadRoutePlatform,
} from './daemon-read-route-guard';
import { translateFilesServiceError } from './worker-filesystem-adapter';
import { daemonUnreachableReason } from './electron-daemon-connection';
import type {
  CallerLifetimeSender,
  ElectronDaemonCallerLifetime,
} from './electron-daemon-caller-lifetime';

/**
 * Routing of Files reads through the local core daemon (CAN-4305, CAN-5509),
 * selected per platform for eligible local Files requests.
 *
 * Only the Files IPC handlers mark a request as routable; every other caller
 * of the same operations keeps the direct desktop reader. The backend is
 * chosen once, before any daemon contact. A request selected for the daemon
 * falls back to the direct reader only when the daemon can't be reached: its
 * data root can't be prepared, its connection can't be set up (a tagged
 * `get` failure), or the attempt's own connection closed under it (CAN-5541).
 * Every refusal from a reached daemon, and every check before contact, is
 * returned typed with no direct read. Search walks pin their backend before
 * their first page and never fall back mid-walk; a walk selected while the
 * daemon is latched unreachable reads directly from the start (q-6, CAN-5556).
 */

/**
 * The reads with a daemon path: roots and directory listings, scoped
 * `file:read-content` (CAN-4099), each `file-index:get` search page
 * (CAN-5037) and `file-reference:resolve` (CAN-5038). Kept literal, never
 * derived from the filesystem operation set.
 */
export type DaemonFilesOperation =
  | 'roots'
  | 'directory'
  | 'file'
  | 'search'
  | 'link';

export type FilesRouteObservedOperation = DaemonFilesOperation;

/**
 * Per-platform production selection: reads that may leave with a plan.
 * Windows qualification (CAN-4732) must not enable production routes;
 * Files read enablement requires a separate code change (CAN-4729).
 * Listed literally, so a new read never becomes selectable by accident.
 */
export const DAEMON_FILES_PRODUCTION_SELECTION: Readonly<
  Record<ReadRoutePlatform, ReadonlySet<DaemonFilesOperation>>
> = {
  darwin: new Set<DaemonFilesOperation>([
    'roots',
    'directory',
    'file',
    'search',
    'link',
  ]),
  win32: new Set<DaemonFilesOperation>(['roots', 'directory']),
  linux: new Set<DaemonFilesOperation>([
    'roots',
    'directory',
    'file',
    'search',
    'link',
  ]),
};

const NO_PRODUCTION_SELECTION: ReadonlySet<DaemonFilesOperation> = new Set();

export interface DaemonFilesRouteSender extends CallerLifetimeSender {
  readonly id: number;
}

/** Set only by the file-tree IPC handlers, from the trusted IPC event. */
export interface DaemonFilesRouteRequest {
  readonly sender: DaemonFilesRouteSender;
}

export interface DaemonFilesQueryClient {
  /** Aborts when this connection closes, whatever closed it. */
  readonly signal: AbortSignal;
  query(
    name: 'worker.filesystem.roots.list',
    params: WorkerFilesystemRootsListParams,
    options?: CanopyClientQueryOptions,
  ): Promise<WorkerFilesystemRootsListResult>;
  query(
    name: 'worker.filesystem.directory.list',
    params: WorkerFilesystemDirectoryListParams,
    options?: CanopyClientQueryOptions,
  ): Promise<WorkerFilesystemDirectoryListResult>;
  query(
    name: 'worker.filesystem.file.read',
    params: WorkerFilesystemFileReadParams,
    options?: CanopyClientQueryOptions,
  ): Promise<WorkerFilesystemFileReadResult>;
  query(
    name: 'worker.filesystem.search',
    params: WorkerFilesystemSearchParams,
    options?: CanopyClientQueryOptions,
  ): Promise<WorkerFilesystemSearchResult>;
  query(
    name: 'worker.filesystem.link.resolve',
    params: WorkerFilesystemLinkResolveParams,
    options?: CanopyClientQueryOptions,
  ): Promise<WorkerFilesystemLinkResolveResult>;
}

export interface DaemonFilesSession {
  /** Throws once the session closed; a new object after the backend reattached. */
  readonly client: DaemonFilesQueryClient;
}

export interface DaemonFilesConnections {
  get(
    caller: CanopyCallerDescriptor,
    owner: AbortSignal,
  ): Promise<DaemonFilesSession>;
}

/** Main's background service record, as the Files reads consume it. */
export interface DaemonFilesReachability {
  /** Selected reads skip the daemon and read in-process. */
  readonly isLatched: () => boolean;
  /** Called before the direct reader answers a selected read instead. */
  readonly noteFallback: (reason: BackgroundServiceUnreachableReason) => void;
}

const UNOBSERVED_REACHABILITY: DaemonFilesReachability = {
  isLatched: () => false,
  noteFallback: () => undefined,
};

export interface DaemonFilesHostContext {
  /** The verified local authority the daemon serves. */
  readonly authorityId: string;
  /** The realpath of the data root; catalog revisions hash these paths. */
  readonly canonicalDataRoot: string;
}

export interface DaemonFilesRouteOptions {
  readonly lifetime: ElectronDaemonCallerLifetime;
  /** Lazy: called only for a request already selected for the daemon. */
  readonly connections: () => DaemonFilesConnections;
  /** Lazy: called only for a request already selected for the daemon. */
  readonly hostContext: () => Promise<DaemonFilesHostContext>;
  /** The build brand's managed Cowork folder name, as the daemon build bakes it. */
  readonly coworkManagedDirName: string;
  /** The data root spelling the direct reader returns in `absolutePath`. */
  readonly displayDataRoot: () => string;
  readonly workspaceType: (workspaceId: string) => WorkspaceType | null;
  readonly resolveWorktreeTargetIds: (
    projectId: string,
    worktreeId: string,
  ) => { projectId: string; worktreeId: string } | null;
  readonly createScopeResolver?: (
    context: DaemonFilesHostContext,
  ) => Promise<FilesystemScopeResolver>;
  /** Omitted: never latched, and fallbacks report to no one. */
  readonly reachability?: DaemonFilesReachability;
  /** Failure bound for one daemon query, not a performance budget. */
  readonly queryDeadlineMs?: number;
  /** Whose entry-name rules a listing must satisfy; defaults to this host's. */
  readonly entryNamePlatform?: 'posix' | 'win32';
  /** The read-route table's host; defaults to this one, `null` if unsupported. */
  readonly platform?: ReadRoutePlatform | null;
  /** Test seam: the reads that may leave with a plan; defaults to production's. */
  readonly selectable?: ReadonlySet<DaemonFilesOperation>;
}

export interface DaemonFilesRouteRun<Result, Legacy> {
  /** The unchanged direct handler; it captures its own legacy result. */
  direct: () => Promise<Result>;
  /** Stores the legacy projection of a daemon result. */
  capture: (legacy: Legacy) => void;
}

export interface DaemonFilesLinkRun extends DaemonFilesRouteRun<
  WorkerFilesystemLinkResolveResult,
  FilesystemLinkResolved
> {
  /**
   * The markdown base is a host path outside every root. It has no portable
   * form, so the request stays direct before any contact (CAN-4729 decides
   * whether for good).
   */
  readonly hostBase: boolean;
}

/**
 * One `file-index:get` request's walks, pinned to the backend chosen before
 * its first page. Every page and cursor of its roots stays on that backend.
 */
export interface DaemonFilesSearchWalk {
  readonly backend: 'direct' | 'daemon';
  /**
   * The index coalescing lane, `null` for the lane retained direct callers
   * share. A daemon walk gets its own lane per document, so a request never
   * waits on a walk that another document's reload would end.
   */
  readonly lane: string | null;
}

export interface DaemonFilesSearchRun extends DaemonFilesRouteRun<
  WorkerFilesystemSearchResult,
  FilesystemSearchPage
> {
  readonly walk: DaemonFilesSearchWalk;
}

export interface DaemonFilesRoute {
  roots(
    params: WorkerFilesystemRootsListParams,
    context: CanopyHandlerContext,
    request: DaemonFilesRouteRequest,
    run: DaemonFilesRouteRun<
      WorkerFilesystemRootsListResult,
      FileTreeRootsResponse
    >,
  ): Promise<WorkerFilesystemRootsListResult>;
  directory(
    params: WorkerFilesystemDirectoryListParams,
    context: CanopyHandlerContext,
    request: DaemonFilesRouteRequest,
    run: DaemonFilesRouteRun<
      WorkerFilesystemDirectoryListResult,
      FileTreeDirectoryResponse
    >,
  ): Promise<WorkerFilesystemDirectoryListResult>;
  file(
    params: WorkerFilesystemFileReadParams,
    context: CanopyHandlerContext,
    request: DaemonFilesRouteRequest,
    run: DaemonFilesRouteRun<
      WorkerFilesystemFileReadResult,
      FilesystemFileRead
    >,
  ): Promise<WorkerFilesystemFileReadResult>;
  /** Decides the backend of one index request, before any contact. */
  searchWalk(
    scope: CanopyWorkspaceScope,
    caller: CanopyCallerDescriptor,
    request: DaemonFilesRouteRequest,
  ): DaemonFilesSearchWalk;
  /** One page of a walk `searchWalk` pinned; an unknown walk stays direct. */
  search(
    params: WorkerFilesystemSearchParams,
    context: CanopyHandlerContext,
    request: DaemonFilesRouteRequest,
    run: DaemonFilesSearchRun,
  ): Promise<WorkerFilesystemSearchResult>;
  link(
    params: WorkerFilesystemLinkResolveParams,
    context: CanopyHandlerContext,
    request: DaemonFilesRouteRequest,
    run: DaemonFilesLinkRun,
  ): Promise<WorkerFilesystemLinkResolveResult>;
  dispose(): void;
}

export interface ObservedDaemonFilesRoute extends DaemonFilesRoute {
  observe(after?: ReadEvidenceCursor): FilesRouteEvidenceSnapshot;
}

/**
 * Scopes that keep their existing route: Bots and the sealed
 * shared-container viewer, and the plan-explore/code-review aliases, whose
 * daemon support is CAN-4399.
 */
export const DAEMON_FILES_EXCLUDED_WORKSPACE_IDS: ReadonlySet<string> = new Set(
  [
    SHARED_CONTAINER_VIEWER_PROJECT_ID,
    PLAN_EXPLORE_CHAT_PROJECT_ID,
    CODE_REVIEW_CHAT_PROJECT_ID,
  ],
);

const ROUTED_WORKSPACE_TYPES: ReadonlySet<WorkspaceType> =
  new Set<WorkspaceType>(['single-repo', 'multi-repo', 'cowork']);

const DEFAULT_QUERY_DEADLINE_MS = 30_000;
const ROUTE_REFRESH = {
  kind: 'after_refresh',
  resource: 'filesystem-roots',
} as const;

const OPERATION_CODES: Readonly<
  Record<DaemonFilesOperation, ReadonlySet<string>>
> = {
  roots: new Set([
    'worker.filesystem.roots.invalidState',
    'worker.filesystem.roots.revisionConflict',
    'worker.filesystem.roots.notFound',
    'worker.filesystem.roots.snapshotUnavailable',
  ]),
  directory: new Set([
    'worker.filesystem.directory.invalidState',
    'worker.filesystem.directory.revisionConflict',
    'worker.filesystem.directory.notFound',
    'worker.filesystem.directory.snapshotUnavailable',
  ]),
  file: new Set(WORKER_FILESYSTEM_FILE_READ_ERROR_CODES),
  search: new Set(WORKER_FILESYSTEM_SEARCH_ERROR_CODES),
  link: new Set(WORKER_FILESYSTEM_LINK_RESOLVE_ERROR_CODES),
};

interface ProjectionChecks {
  /** This is the one bounded refresh after a conflict. */
  readonly retrying: boolean;
  /** The daemon's own attachments-visibility predicate, over the same deps. */
  readonly rootVisible: (absolutePath: string) => Promise<boolean>;
}

function rootVisibilityOf(
  dependencies: FilesystemScopeDependencies,
): (absolutePath: string) => Promise<boolean> {
  return dependencies.rootVisibility ?? readRootVisibility;
}

interface DaemonPlan {
  readonly scope: { readonly workspaceId: string; readonly worktreeId: string };
  readonly caller: CanopyCallerDescriptor;
  readonly sender: DaemonFilesRouteSender;
}

function routeError(
  kind: CanopyErrorPayload['kind'],
  message: string,
  retry: CanopyErrorPayload['retry'] = { kind: 'never' },
): CanopyOperationError {
  return new CanopyOperationError({ kind, message, retry });
}

function routeChangedError(): CanopyOperationError {
  return routeError(
    'cancelled',
    'The Files read route changed while this read ran. Refresh and retry.',
    ROUTE_REFRESH,
  );
}

function documentClosedError(): CanopyOperationError {
  return routeError('cancelled', 'The requesting window closed or reloaded.');
}

/**
 * The operation's typed form of a routed failure: kind, message and details
 * are kept, a code only when the operation declares it, and retry becomes
 * `never` unless it is a refresh.
 */
export function normalizeDaemonFilesError(
  operation: DaemonFilesOperation,
  error: unknown,
): CanopyOperationError {
  const payload =
    error instanceof CanopyOperationError || error instanceof CanopyClientError
      ? error.payload
      : null;
  if (!payload) return routeError('internal', 'The daemon Files read failed.');
  const code =
    payload.code !== undefined && OPERATION_CODES[operation].has(payload.code)
      ? payload.code
      : undefined;
  return new CanopyOperationError({
    kind: payload.kind,
    message: payload.message,
    ...(code !== undefined && { code }),
    ...(payload.details !== undefined && { details: payload.details }),
    retry:
      payload.retry.kind === 'after_refresh'
        ? payload.retry
        : { kind: 'never' },
  });
}

/**
 * The direct reader's own request checks, in its order, with its errors
 * (payload and runtime cause), so the backend never changes how a malformed
 * request fails. They check the ids the caller sent, before alias mapping,
 * and run before any contact. Returns the daemon's spelling of the relative
 * directory: the direct reader lists the root for a leftover `.` (from
 * `./`); the daemon spells the root `''`.
 */
function checkDirectReaderRequest(
  operation: DaemonFilesOperation,
  scope: CanopyWorkspaceScope,
  directory?: { readonly fileRootId: string; readonly relativePath: string },
): string {
  try {
    validateId(scope.workspaceId, 'projectId');
    validateId(scope.worktreeId, 'worktreeId');
    if (!directory) return '';
    validateOptionalRepoId(directory.fileRootId, 'repoId');
    const relativePath = normalizeFileTreeRelativePath(directory.relativePath);
    return relativePath === '.' ? '' : relativePath;
  } catch (error) {
    const failure = translateFilesServiceError(error);
    recordFilesRouteOutcome(operation, `daemon.failed.${failure.payload.kind}`);
    throw new CanopyOperationError(failure.payload, failure.runtimeCause);
  }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(documentClosedError());
  return new Promise<T>((settle, reject) => {
    const onAbort = (): void => reject(documentClosedError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        settle(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

type FilesRouteEvidenceEvent = {
  operation: FilesRouteObservedOperation;
  /** The backend selected at the start; `fallback` ends a daemon read served directly. */
  backend: 'direct' | 'daemon';
  senderId: number;
  generation: number;
  request: number;
  phase: 'started' | 'success' | 'fallback' | 'failed';
};

/** One observed read; set when the direct reader answered a daemon selection. */
interface ObservedRead {
  fellBack: boolean;
}

export interface FilesRouteEvidenceSnapshot extends ReadEvidenceSnapshot<FilesRouteEvidenceEvent> {
  enabled: boolean;
  generation: number;
  disposed: boolean;
}

function createRouteEvidence(): ReadEvidenceJournal<FilesRouteEvidenceEvent> {
  return createBoundedReadEvidence<FilesRouteEvidenceEvent>();
}

export function createDaemonFilesRoute(
  options: DaemonFilesRouteOptions,
): ObservedDaemonFilesRoute {
  const queryDeadlineMs = options.queryDeadlineMs ?? DEFAULT_QUERY_DEADLINE_MS;
  const entryNamePlatform =
    options.entryNamePlatform ?? (sep === '/' ? 'posix' : 'win32');
  const platform =
    options.platform !== undefined
      ? options.platform
      : resolveReadRoutePlatform();
  const selectable =
    options.selectable ??
    (platform === null
      ? NO_PRODUCTION_SELECTION
      : DAEMON_FILES_PRODUCTION_SELECTION[platform]);
  const reachability = options.reachability ?? UNOBSERVED_REACHABILITY;
  const evidence = createRouteEvidence();
  let requestSequence = 0;
  const observeRead = async <T>(
    operation: FilesRouteObservedOperation,
    backend: 'direct' | 'daemon',
    senderId: number,
    run: (read: ObservedRead) => Promise<T>,
  ): Promise<T> => {
    const event = {
      operation,
      backend,
      senderId,
      generation,
      request: ++requestSequence,
    };
    const read: ObservedRead = { fellBack: false };
    evidence.record({ ...event, phase: 'started' });
    try {
      const result = await run(read);
      evidence.record({
        ...event,
        phase: read.fellBack ? 'fallback' : 'success',
      });
      return result;
    } catch (error) {
      evidence.record({ ...event, phase: 'failed' });
      throw error;
    }
  };
  const enabled = true;
  const generation = 0;
  const routeLifetime = new AbortController();
  let disposed = false;

  let resolver:
    | { key: string; resolve: Promise<FilesystemScopeResolver> }
    | undefined;
  const scopeResolverFor = (
    context: DaemonFilesHostContext,
  ): Promise<FilesystemScopeResolver> => {
    const key = JSON.stringify([
      context.authorityId,
      context.canonicalDataRoot,
    ]);
    if (resolver?.key === key) return resolver.resolve;
    // The daemon's own resolver inputs; any difference changes every revision.
    const pending = (
      options.createScopeResolver ??
      ((host: DaemonFilesHostContext): Promise<FilesystemScopeResolver> =>
        createFilesystemScopeResolver({
          canonicalDataRoot: host.canonicalDataRoot,
          authorityId: host.authorityId,
          targetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
          coworkManagedDirName: options.coworkManagedDirName,
          paths: { join, resolve, isAbsolute, sep, basename },
          rootIdentity: readNativeRootIdentity,
        }))
    )(context);
    const entry = { key, resolve: pending };
    resolver = entry;
    void pending.catch(() => {
      if (resolver === entry) resolver = undefined;
    });
    return pending;
  };

  /**
   * Whether the route decides this request's backend: the shared read-route
   * guard (platform table, trusted caller for this exact sender, an eligible
   * scope, nothing foreign selected). Local lookups only, never daemon
   * contact; `null` keeps the direct reader when ineligible.
   */
  const eligibility = (
    operation: DaemonFilesOperation,
    scope: CanopyWorkspaceScope,
    caller: CanopyCallerDescriptor,
    request: DaemonFilesRouteRequest,
  ): DaemonPlan | null => {
    if (disposed) return null;
    const guarded: FilesReadRouteOperation = `files.${operation}`;
    const target = evaluateReadRoute({
      operation: guarded,
      platform,
      caller,
      senderId: request.sender.id,
      scope,
      lookups: {
        resolveWorktreeTargetIds: options.resolveWorktreeTargetIds,
        workspaceType: options.workspaceType,
        excludedWorkspaceIds: DAEMON_FILES_EXCLUDED_WORKSPACE_IDS,
        routedWorkspaceTypes: ROUTED_WORKSPACE_TYPES,
      },
    });
    if (target?.shape !== 'worktree') return null;
    return {
      scope: { workspaceId: target.workspaceId, worktreeId: target.worktreeId },
      caller,
      sender: request.sender,
    };
  };

  /**
   * Decided before any daemon contact; `null` keeps the direct reader. Only
   * a selectable operation can leave with a plan.
   */
  const select = (
    operation: DaemonFilesOperation,
    scope: CanopyWorkspaceScope,
    caller: CanopyCallerDescriptor,
    request: DaemonFilesRouteRequest,
  ): DaemonPlan | null => {
    if (!selectable.has(operation)) return null;
    return eligibility(operation, scope, caller, request);
  };

  const runDirect = async <Result>(
    operation: DaemonFilesOperation,
    direct: () => Promise<Result>,
    /** A fallback: the request already counted its `daemon` selection. */
    selected = false,
  ): Promise<Result> => {
    if (!selected) recordFilesRouteSelected(operation, 'direct');
    return direct();
  };

  interface SearchWalkPin {
    /** `owner` is the requesting document at the start; its reload ends the walk. */
    readonly daemon: { plan: DaemonPlan; owner: AbortSignal } | null;
    /** Selected while latched: every page reads directly, counted as bypassed. */
    readonly bypassed: boolean;
  }
  const searchWalks = new WeakMap<DaemonFilesSearchWalk, SearchWalkPin>();
  const documentLanes = new WeakMap<AbortSignal, number>();
  let documentLaneSequence = 0;
  const documentLane = (owner: AbortSignal): number => {
    const known = documentLanes.get(owner);
    if (known !== undefined) return known;
    documentLaneSequence += 1;
    documentLanes.set(owner, documentLaneSequence);
    return documentLaneSequence;
  };

  /**
   * Where a selected read goes when the daemon can't be reached. Omitted (a
   * search page), every failure stays typed.
   */
  interface DaemonFallback<Result> {
    readonly direct: () => Promise<Result>;
    readonly read: ObservedRead;
  }
  type DaemonAttempt<Canonical, Legacy> =
    | {
        readonly kind: 'served';
        readonly canonical: Canonical;
        readonly legacy: Legacy;
      }
    | {
        readonly kind: 'unreachable';
        readonly reason: BackgroundServiceUnreachableReason | 'bypassed';
        readonly fallback: DaemonFallback<Canonical>;
      };
  /** `legacy` only for a daemon result; the direct reader captured its own. */
  type DaemonRead<Canonical, Legacy> =
    | {
        readonly served: true;
        readonly canonical: Canonical;
        readonly legacy: Legacy;
      }
    | { readonly served: false; readonly canonical: Canonical };

  const runDaemon = async <
    Canonical extends { catalogRevision?: string },
    Legacy,
  >(
    operation: DaemonFilesOperation,
    plan: DaemonPlan,
    context: CanopyHandlerContext,
    query: (
      client: DaemonFilesQueryClient,
      scope: CanopyWorkspaceScope,
      queryOptions: CanopyClientQueryOptions,
    ) => Promise<Canonical>,
    project: (
      result: Canonical,
      catalog: FilesystemRootCatalog,
      projectPath: (path: string) => string,
      checks: ProjectionChecks,
    ) => Legacy | Promise<Legacy>,
    {
      owner = options.lifetime.ownerFor(plan.sender),
      refreshOnConflict = true,
      fallback,
    }: {
      /** The plan's document; once it retires, the read fails before contact. */
      readonly owner?: AbortSignal;
      /** False for a cursor page: the daemon already consumed its cursor. */
      readonly refreshOnConflict?: boolean;
      readonly fallback?: DaemonFallback<Canonical>;
    } = {},
  ): Promise<DaemonRead<Canonical, Legacy>> => {
    const signal = AbortSignal.any([
      context.signal,
      owner,
      routeLifetime.signal,
    ]);
    const throwIfInvalidated = (): void => {
      if (disposed) throw routeChangedError();
      if (owner.aborted) throw documentClosedError();
    };
    // The current attempt's stage, so only a host, connect or connection
    // failure reads as an unreachable daemon.
    let hostFailed = false;
    let contacted: DaemonFilesQueryClient | null = null;
    const unreachableReason = (
      error: unknown,
    ): BackgroundServiceUnreachableReason | null => {
      if (hostFailed) return 'host_unavailable';
      if (contacted === null) return daemonUnreachableReason(error);
      // Its own connection closed, and not because the request ended (its
      // document, route disposal were checked before this).
      return contacted.signal.aborted && !signal.aborted
        ? 'connection_lost'
        : null;
    };
    const attempt = async (
      retrying: boolean,
    ): Promise<DaemonAttempt<Canonical, Legacy>> => {
      throwIfInvalidated();
      hostFailed = false;
      contacted = null;
      let host: DaemonFilesHostContext;
      let resolveScope: FilesystemScopeResolver;
      try {
        host = await options.hostContext();
        resolveScope = await scopeResolverFor(host);
      } catch (error) {
        hostFailed = true;
        throw error instanceof CanopyOperationError ||
          error instanceof CanopyClientError
          ? error
          : routeError(
              'unavailable',
              'The desktop daemon data root could not be prepared.',
            );
      }
      // `local-desktop` becomes the verified daemon authority here, and only here.
      const scope: CanopyWorkspaceScope = {
        ...plan.scope,
        authorityId: host.authorityId,
      };
      // The trusted owner resolves first: a malformed owner fails before contact.
      const dependencies = await resolveScope(scope, operation);
      throwIfInvalidated();
      if (fallback && reachability.isLatched())
        return { kind: 'unreachable', reason: 'bypassed', fallback };
      const session = await raceAbort(
        options
          .connections()
          .get({ ...plan.caller, authorityId: host.authorityId }, owner),
        signal,
      );
      const client = session.client;
      contacted = client;
      recordFilesRouteOutcome(operation, 'daemon.queries');
      const result = await query(client, scope, {
        signal,
        metadata: {
          deadlineAt: new Date(Date.now() + queryDeadlineMs).toISOString(),
        },
      });
      const requireSameBackend = (): void => {
        if (session.client !== client)
          throw routeError(
            'unavailable',
            'The desktop daemon connection changed. Retry the read.',
          );
      };
      requireSameBackend();
      throwIfInvalidated();
      const revision = requireFilesystemCatalogRevision(result, operation);
      const canonicalRoot = host.canonicalDataRoot;
      const displayRoot = resolve(options.displayDataRoot());
      const projectPath = (path: string): string => {
        if (path === canonicalRoot) return displayRoot;
        if (path.startsWith(`${canonicalRoot}${sep}`))
          return `${displayRoot}${path.slice(canonicalRoot.length)}`;
        // Attached Cowork folders live outside the data root.
        return path;
      };
      const legacy = await withVerifiedFilesystemCatalog(
        scope,
        revision,
        dependencies,
        operation,
        async (catalog) =>
          project(result, catalog, projectPath, {
            retrying,
            rootVisible: rootVisibilityOf(dependencies),
          }),
      );
      requireSameBackend();
      throwIfInvalidated();
      return { kind: 'served', canonical: result, legacy };
    };
    const attempts = async (): Promise<DaemonAttempt<Canonical, Legacy>> => {
      try {
        for (let conflicts = 0; ; conflicts += 1) {
          try {
            const outcome = await attempt(conflicts > 0);
            if (outcome.kind === 'served')
              recordFilesRouteOutcome(operation, 'daemon.served');
            return outcome;
          } catch (error) {
            throwIfInvalidated();
            // On the raw error: normalizing drops the connection's tag.
            const reason = fallback ? unreachableReason(error) : null;
            if (fallback && reason)
              return { kind: 'unreachable', reason, fallback };
            const failure = normalizeDaemonFilesError(operation, error);
            if (failure.payload.kind !== 'conflict' || !refreshOnConflict)
              throw failure;
            // One bounded refresh: re-resolve, re-query and re-project once.
            if (conflicts >= 1)
              throw filesystemScopeError(operation, 'revisionConflict');
            recordFilesRouteOutcome(operation, 'daemon.retries');
          }
        }
      } catch (error) {
        const failure = normalizeDaemonFilesError(operation, error);
        recordFilesRouteOutcome(
          operation,
          `daemon.failed.${failure.payload.kind}`,
        );
        throw failure;
      }
    };
    const outcome = await attempts();
    if (outcome.kind === 'served')
      return {
        served: true,
        canonical: outcome.canonical,
        legacy: outcome.legacy,
      };
    if (outcome.reason === 'bypassed')
      recordFilesRouteOutcome(operation, 'daemon.bypassed');
    else {
      recordFilesRouteOutcome(operation, `daemon.fallback.${outcome.reason}`);
      // Before the direct reply: one read is enough to warn.
      reachability.noteFallback(outcome.reason);
    }
    outcome.fallback.read.fellBack = true;
    throwIfInvalidated();
    const canonical = await runDirect(operation, outcome.fallback.direct, true);
    throwIfInvalidated();
    return { served: false, canonical };
  };

  return {
    async roots(
      params,
      context,
      request,
      run,
    ): Promise<WorkerFilesystemRootsListResult> {
      const plan = select('roots', params.scope, context.caller, request);
      return observeRead(
        'roots',
        plan ? 'daemon' : 'direct',
        request.sender.id,
        async (read) => {
          if (!plan) return runDirect('roots', run.direct);
          recordFilesRouteSelected('roots', 'daemon');
          checkDirectReaderRequest('roots', params.scope);
          const served = await runDaemon<
            WorkerFilesystemRootsListResult,
            FileTreeRootsResponse
          >(
            'roots',
            plan,
            context,
            (client, scope, queryOptions) =>
              client.query(
                'worker.filesystem.roots.list',
                { scope },
                queryOptions,
              ),
            projectRoots,
            { fallback: { direct: run.direct, read } },
          );
          if (served.served) run.capture(served.legacy);
          return served.canonical;
        },
      );
    },
    async directory(
      params,
      context,
      request,
      run,
    ): Promise<WorkerFilesystemDirectoryListResult> {
      const plan = select('directory', params.scope, context.caller, request);
      return observeRead(
        'directory',
        plan ? 'daemon' : 'direct',
        request.sender.id,
        async (read) => {
          if (!plan) return runDirect('directory', run.direct);
          recordFilesRouteSelected('directory', 'daemon');
          const relativePath = checkDirectReaderRequest(
            'directory',
            params.scope,
            params,
          );
          const served = await runDaemon<
            WorkerFilesystemDirectoryListResult,
            FileTreeDirectoryResponse
          >(
            'directory',
            plan,
            context,
            async (client, scope, queryOptions) =>
              inDirectReaderOrder(
                await client.query(
                  'worker.filesystem.directory.list',
                  { scope, fileRootId: params.fileRootId, relativePath },
                  queryOptions,
                ),
              ),
            (result, catalog, projectPath, checks) =>
              projectDirectory(
                params.fileRootId,
                relativePath,
                result,
                catalog,
                projectPath,
                entryNamePlatform,
                checks,
              ),
            { fallback: { direct: run.direct, read } },
          );
          if (served.served) run.capture(served.legacy);
          return served.canonical;
        },
      );
    },
    async file(
      params,
      context,
      request,
      run,
    ): Promise<WorkerFilesystemFileReadResult> {
      const plan = select('file', params.scope, context.caller, request);
      return observeRead(
        'file',
        plan ? 'daemon' : 'direct',
        request.sender.id,
        async (read) => {
          if (!plan) return runDirect('file', run.direct);
          recordFilesRouteSelected('file', 'daemon');
          checkDirectReaderRequest('file', params.scope);
          const served = await runDaemon<
            WorkerFilesystemFileReadResult,
            FilesystemFileRead
          >(
            'file',
            plan,
            context,
            (client, scope, queryOptions) =>
              client.query(
                'worker.filesystem.file.read',
                { ...params, scope },
                queryOptions,
              ),
            (result, catalog) => projectFileRead(params, result, catalog),
            { fallback: { direct: run.direct, read } },
          );
          if (served.served) run.capture(served.legacy);
          return served.canonical;
        },
      );
    },
    searchWalk(scope, caller, request): DaemonFilesSearchWalk {
      const plan = select('search', scope, caller, request);
      // Decided once, before contact: a latched walk reads directly (q-6),
      // and a walk already on the daemon stays there.
      const bypassed = plan !== null && reachability.isLatched();
      const daemon =
        plan && !bypassed
          ? { plan, owner: options.lifetime.ownerFor(plan.sender) }
          : null;
      const walk: DaemonFilesSearchWalk = daemon
        ? {
            backend: 'daemon',
            lane: `daemon:${documentLane(daemon.owner)}`,
          }
        : {
            backend: 'direct',
            lane: bypassed ? 'direct:unreachable' : null,
          };
      searchWalks.set(walk, { daemon, bypassed });
      return walk;
    },
    async search(
      params,
      context,
      request,
      run,
    ): Promise<WorkerFilesystemSearchResult> {
      const pin = searchWalks.get(run.walk);
      const daemon = pin?.daemon ?? null;
      return observeRead(
        'search',
        daemon || pin?.bypassed ? 'daemon' : 'direct',
        request.sender.id,
        async (read) => {
          if (pin?.bypassed) {
            recordFilesRouteSelected('search', 'daemon');
            checkDirectReaderRequest('search', params.scope);
            recordFilesRouteOutcome('search', 'daemon.bypassed');
            read.fellBack = true;
            return runDirect('search', run.direct, true);
          }
          if (!pin || !daemon) return runDirect('search', run.direct);
          recordFilesRouteSelected('search', 'daemon');
          checkDirectReaderRequest('search', params.scope);
          const served = await runDaemon<
            WorkerFilesystemSearchResult,
            FilesystemSearchPage
          >(
            'search',
            daemon.plan,
            context,
            (client, scope, queryOptions) =>
              client.query(
                'worker.filesystem.search',
                { ...params, scope },
                queryOptions,
              ),
            (result, catalog, projectPath) =>
              projectSearchPage(
                params.fileRootId,
                result,
                catalog,
                projectPath,
                entryNamePlatform,
              ),
            {
              owner: daemon.owner,
              refreshOnConflict: params.cursor === undefined,
            },
          );
          if (served.served) run.capture(served.legacy);
          return served.canonical;
        },
      );
    },
    async link(
      params,
      context,
      request,
      run,
    ): Promise<WorkerFilesystemLinkResolveResult> {
      const plan = run.hostBase
        ? null
        : select('link', params.scope, context.caller, request);
      return observeRead(
        'link',
        plan ? 'daemon' : 'direct',
        request.sender.id,
        async (read) => {
          if (!plan) return runDirect('link', run.direct);
          recordFilesRouteSelected('link', 'daemon');
          checkDirectReaderRequest('link', params.scope);
          const served = await runDaemon<
            WorkerFilesystemLinkResolveResult,
            FilesystemLinkResolved
          >(
            'link',
            plan,
            context,
            (client, scope, queryOptions) =>
              client.query(
                'worker.filesystem.link.resolve',
                { ...params, scope },
                queryOptions,
              ),
            (result, catalog, projectPath) =>
              projectLink(result, catalog, projectPath, entryNamePlatform),
            { fallback: { direct: run.direct, read } },
          );
          if (served.served) run.capture(served.legacy);
          return served.canonical;
        },
      );
    },
    observe(after): FilesRouteEvidenceSnapshot {
      return { ...evidence.snapshot(after), enabled, generation, disposed };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      routeLifetime.abort();
    },
  };
}

/**
 * The daemon lists an attachments root exactly while it has visible entries.
 * A mismatch is either a file added or removed after the daemon's read, which
 * the one refresh resolves, or a wrong reply, which persists.
 */
async function requireAttachmentsListing(
  absolutePath: string,
  isListed: boolean,
  checks: ProjectionChecks,
): Promise<void> {
  if ((await checks.rootVisible(absolutePath)) === isListed) return;
  if (checks.retrying) throw filesystemScopeError('roots', 'invalidState');
  throw filesystemScopeError('roots', 'revisionConflict');
}

/**
 * Legacy roots from a validated daemon result and the matching private
 * catalog. Ids, names and kinds must match the catalog, appear once, and keep
 * the catalog's order. An attachments root is listed exactly while it has
 * visible entries, as both readers decide.
 */
async function projectRoots(
  result: WorkerFilesystemRootsListResult,
  catalog: FilesystemRootCatalog,
  projectPath: (path: string) => string,
  checks: ProjectionChecks,
): Promise<FileTreeRootsResponse> {
  const invalid = (): never => {
    throw filesystemScopeError('roots', 'invalidState');
  };
  const listed = result.roots;
  let index = 0;
  const roots: FileTreeRootsResponse['roots'] = [];
  for (const trusted of catalog.roots) {
    const root = listed[index];
    const isListed = root?.fileRootId === trusted.id;
    if (trusted.kind === 'attachments')
      await requireAttachmentsListing(trusted.absolutePath, isListed, checks);
    else if (!isListed) invalid();
    if (!isListed || root === undefined) continue;
    if (trusted.name !== root.name || trusted.kind !== root.kind) invalid();
    roots.push({
      repoId: root.fileRootId,
      repoName: root.name,
      absolutePath: projectPath(trusted.absolutePath),
      rootKind: root.kind,
    });
    index += 1;
  }
  // Unknown, duplicate or out-of-order ids are left over.
  if (index !== listed.length) invalid();
  return { roots };
}

// Win32 device basenames, with or without spaces and an extension.
const WIN32_DEVICE_NAME =
  /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³]) *(?:\.|$)/i;
// NTFS aliases of `.git` that the case-sensitive `.git` check misses (Git
// for Windows' core.protectNTFS set; trailing dots, spaces and streams are
// refused separately).
const WIN32_DOT_GIT_ALIAS = /^(?:\.git|git~1)$/i;

/**
 * One name as the platform's directory listing can return it. POSIX names
 * may hold `\` or start like a drive (`c:notes`); the direct reader lists
 * them, so they are not refused here. On Windows, `:` (drive-relative or
 * stream syntax), device names, `.git` aliases and a trailing dot or space
 * would make the joined path name something other than this child, so they
 * are refused.
 */
export function isDirectoryEntryName(
  name: string,
  platform: 'posix' | 'win32',
): boolean {
  if (
    name === '' ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\0')
  )
    return false;
  if (platform === 'posix') return true;
  return (
    !name.includes('\\') &&
    !name.includes(':') &&
    !WIN32_DEVICE_NAME.test(name) &&
    !WIN32_DOT_GIT_ALIAS.test(name) &&
    !/[. ]$/.test(name)
  );
}

/**
 * The direct reader's comparator, run here in main, so the daemon's locale
 * cannot change the entry order. Names it ranks equal keep the daemon's
 * order: the direct reader's readdir order is not visible here.
 */
function inDirectReaderOrder(
  result: WorkerFilesystemDirectoryListResult,
): WorkerFilesystemDirectoryListResult {
  return { ...result, entries: sortDirectoryEntries(result.entries) };
}

/**
 * Legacy entries under the catalog root, in the order of the reordered
 * result. Every entry must be a direct child of the requested directory,
 * outside `.git`, and listed once; any other entry rejects the whole response.
 * A hidden attachments root is not a root, as in the roots list.
 */
async function projectDirectory(
  fileRootId: string,
  relativePath: string,
  result: WorkerFilesystemDirectoryListResult,
  catalog: FilesystemRootCatalog,
  projectPath: (path: string) => string,
  entryNamePlatform: 'posix' | 'win32',
  checks: ProjectionChecks,
): Promise<FileTreeDirectoryResponse> {
  const root = catalog.byId.get(fileRootId);
  if (
    !root ||
    (root.kind === 'attachments' &&
      !(await checks.rootVisible(root.absolutePath)))
  )
    throw filesystemScopeError('directory', 'notFound');
  const rootPath = projectPath(root.absolutePath);
  const seen = new Set<string>();
  return {
    entries: result.entries.map((entry) => {
      const expected =
        relativePath === '' ? entry.name : `${relativePath}/${entry.name}`;
      if (
        !isDirectoryEntryName(entry.name, entryNamePlatform) ||
        entry.relativePath !== expected ||
        hasGitPathSegment(entry.relativePath) ||
        seen.has(entry.relativePath)
      )
        throw filesystemScopeError('directory', 'invalidState');
      seen.add(entry.relativePath);
      return {
        name: entry.name,
        relativePath: entry.relativePath,
        absolutePath: join(rootPath, ...entry.relativePath.split('/')),
        kind: entry.kind,
        isIgnored: entry.isIgnored,
        isIndexExcluded: entry.isIndexExcluded,
        isSymlink: entry.isSymlink,
        hasChildren: entry.hasChildren,
      };
    }),
    ...(result.ignoreStateUnknown === true && { ignoreStateUnknown: true }),
  };
}

/** A root-relative path the platform's walk can produce, outside `.git`. */
function isWalkedRelativePath(
  relativePath: string,
  platform: 'posix' | 'win32',
): boolean {
  return (
    relativePath
      .split('/')
      .every((segment) => isDirectoryEntryName(segment, platform)) &&
    !hasGitPathSegment(relativePath)
  );
}

/**
 * The in-process read a daemon file result stands for. The daemon reads the
 * requested root and path or fails. `modifiedAtMs` comes from the contract's
 * ISO `modifiedAt`, so it is whole milliseconds where the direct reader
 * keeps the fractional `mtimeMs` (accepted, CAN-5509).
 */
function projectFileRead(
  params: WorkerFilesystemFileReadParams,
  result: WorkerFilesystemFileReadResult,
  catalog: FilesystemRootCatalog,
): FilesystemFileRead {
  const modifiedAtMs = Date.parse(result.modifiedAt);
  if (
    result.fileRootId !== params.fileRootId ||
    result.relativePath !== params.relativePath ||
    !catalog.byId.has(result.fileRootId) ||
    !Number.isFinite(modifiedAtMs)
  )
    throw filesystemScopeError('file', 'invalidState');
  return { result, modifiedAtMs };
}

/**
 * One search page as the in-process walk captures it: each match is a file
 * of the requested root, and its local path is the catalog root's display
 * spelling joined with the match path, as the walk joins it.
 */
function projectSearchPage(
  fileRootId: string,
  result: WorkerFilesystemSearchResult,
  catalog: FilesystemRootCatalog,
  projectPath: (path: string) => string,
  platform: 'posix' | 'win32',
): FilesystemSearchPage {
  const root = catalog.byId.get(fileRootId);
  if (!root) throw filesystemScopeError('search', 'invalidState');
  const rootPath = projectPath(root.absolutePath);
  return {
    result,
    files: result.matches.map((match) => {
      const segments = match.path.split('/');
      if (
        match.fileRootId !== fileRootId ||
        match.kind !== 'file' ||
        !isWalkedRelativePath(match.path, platform) ||
        match.name !== segments[segments.length - 1]
      )
        throw filesystemScopeError('search', 'invalidState');
      return {
        relativePath: match.path,
        filename: match.name,
        absolutePath: join(rootPath, ...segments),
        isIgnored: match.isIgnored,
      };
    }),
  };
}

/**
 * A daemon link resolution with its matched root's display path. Outside the
 * root itself, the name is the target's last segment, as the resolver names it.
 */
function projectLink(
  result: WorkerFilesystemLinkResolveResult,
  catalog: FilesystemRootCatalog,
  projectPath: (path: string) => string,
  platform: 'posix' | 'win32',
): FilesystemLinkResolved {
  const root = catalog.byId.get(result.fileRootId);
  const segments =
    result.relativePath === '' ? [] : result.relativePath.split('/');
  if (
    !root ||
    !segments.every((segment) => isDirectoryEntryName(segment, platform)) ||
    (segments.length > 0 && result.name !== segments[segments.length - 1])
  )
    throw filesystemScopeError('link', 'invalidState');
  return { result, rootAbsolutePath: projectPath(root.absolutePath) };
}
