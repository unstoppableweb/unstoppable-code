import type {
  CanopyQueryHandlerMap,
  CanopyQueryParams,
  CanopyQueryResult,
  CoreWorkspace,
  CoreWorktree,
} from '@canopy/protocol/canopy-core';
import type {
  SidebarItemsFile,
  WorktreeData,
  WorkspaceConfigFile,
  WorkspaceIndexEntry,
} from '@canopy/desktop-shared/types';
import {
  CanopyOperationError,
  type CanopyHandlerContext,
} from '@canopy/core-runtime';
import {
  readAllSidebarItems,
  readAllSidebarItemsSnapshot,
  readWorkspaceIndexEntry,
  readWorkspaceIndexEntryDetailed,
  type SidebarWorkspaceReads,
  type SidebarWorkspaceStoredFields,
} from '../lib/sidebar-items';
import {
  readWorkspaceConfig,
  readWorkspaceConfigDetailed,
  readWorkspaceWorktrees,
  readWorkspaceWorktreesDetailed,
  type StoredWorkspaceManifestFields,
} from '../lib/workspace-persistence';
import type {
  StoredWorkspaceIndexFields,
  WorkspaceIndexAuthority,
} from '../lib/workspace-index-repository';
import { readEffectiveWorkspaceConfig } from '../lib/workspace-source';
import { isW5ProjectionOnlyView } from '../lib/w5-fallback-read';
import { runW5ReadView } from '../lib/w5-commit-log-file-store';
import type { W5ReadViewOutcome } from '../lib/w5-read-view';
import type { W5CaptureRequest } from '../w5-commit-log/commit-log-worker-contract';
import type { W5RevisionEligibility } from '@canopy/core-runtime/node/w5/commit-log/eligibility';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';
import type { CoreWorkspaceReadProvenance } from './core-workspace-read-provenance';
import {
  projectReadProvenance,
  publishableRevisions,
} from '@canopy/core-runtime/node/workspace/core-workspace-read-provenance';
import {
  checkCoreWorkspaceGetParams,
  checkCoreWorkspaceListParams,
  checkCoreWorkspaceOrganization,
  checkCoreWorktreeGetParams,
  checkCoreWorktreeListParams,
  coreWorkspaceGetResources,
  differentListing,
  findCoreWorktreeAcrossWorkspaces,
  listBinding,
  listPage,
  projectCoreWorkspaceGetRow,
  projectCoreWorktree,
  publishCoreWorkspaceItem,
  publishCoreWorkspaceList,
  selectCoreWorkspaceList,
  selectCoreWorkspaceWorktreeList,
  selectCoreWorktreeGet,
  selectCoreWorktreeListAcrossWorkspaces,
  workspaceNotFound,
  worktreeNotFound,
  type CoreWorkspaceFilters,
  type CoreWorkspaceListPage,
  type CoreWorkspaceProjectedRow,
  type CoreWorkspaceResourceProjection,
  type CoreWorkspaceSelection,
  type CoreWorkspaceSidebarRead,
} from '@canopy/core-runtime/node/workspace/core-workspace-projection';
import {
  createCoreReadSnapshotStore,
  type CoreReadSnapshotBinding,
  type CoreReadSnapshotLimits,
  type CoreReadSnapshotOperation,
  type CoreReadSnapshotStore,
} from '@canopy/core-runtime/node/workspace/core-workspace-read-snapshots';

/*
 * Electron main's `core.workspace.*` / `core.worktree.*` list and get. The
 * scope checks, typed fields, repository sources, worktree rows, provenance
 * filters and paging are the shared projection's (CAN-7732); this adapter
 * keeps the desktop reads, source overlay, RR1 tombstones, legacy captures
 * and host-only failures, and lands each capture before any row projects.
 */

/** Authority of a persisted read: only `ok` proves the content is complete. */
export type CoreWorkspaceReadAuthority = WorkspaceIndexAuthority;

export interface CoreWorkspaceReadServices {
  readAllSidebarItems(): Promise<SidebarItemsFile>;
  readWorkspaceIndexEntry: typeof readWorkspaceIndexEntry;
  readWorkspaceConfig: typeof readWorkspaceConfig;
  readWorkspaceWorktrees: typeof readWorkspaceWorktrees;
  readEffectiveWorkspaceConfig: typeof readEffectiveWorkspaceConfig;
  /**
   * The same reads together with their authority. When present the
   * projections use them, so a capture can pair content with the authority
   * of the read that produced it.
   */
  readAllSidebarItemsSnapshot?(): Promise<{
    file: SidebarItemsFile;
    authority: CoreWorkspaceReadAuthority;
    indexAuthority?: CoreWorkspaceReadAuthority;
    indexedWorkspaceIds?: readonly string[];
    workspaceReads?: ReadonlyMap<string, SidebarWorkspaceReads>;
    /** One per `file.items` entry, at the same position. */
    storedFields?: readonly SidebarWorkspaceStoredFields[];
  }>;
  /** {@link readWorkspaceIndexEntry} with the entry's stored fields. */
  readWorkspaceIndexEntryDetailed?(workspaceId: string): Promise<{
    entry: WorkspaceIndexEntry;
    storedFields: StoredWorkspaceIndexFields;
  } | null>;
  readWorkspaceConfigDetailed?(workspaceId: string): Promise<{
    config: WorkspaceConfigFile;
    authority: CoreWorkspaceReadAuthority;
    ownerMalformed: boolean;
    storedFields?: StoredWorkspaceManifestFields;
  }>;
  readWorkspaceWorktreesDetailed?(workspaceId: string): Promise<{
    worktrees: WorktreeData[];
    authority: CoreWorkspaceReadAuthority;
    recentlyRemovedWorktreeIds?: readonly string[];
  }>;
  /**
   * Serves every W5 read `work` makes from one capture of `request` and
   * refuses its writes. Without it the readers above read as they are.
   */
  readView?<T>(
    request: W5CaptureRequest,
    work: (view: W5ReadViewOutcome) => Promise<T>,
  ): Promise<T>;
}

export interface CoreWorkspaceReadDetail {
  authority: CoreWorkspaceReadAuthority;
  /**
   * For the sidebar snapshot: the authority of the project index read alone.
   * `authority` also folds in every project's manifests, so one unreadable
   * project lowers it without the index itself being unreliable.
   */
  indexAuthority?: CoreWorkspaceReadAuthority;
  /** Incomplete worktree membership from the same unscoped sidebar snapshot. */
  worktreePreserveWorkspaceIds?: readonly string[];
  ownerMalformed?: boolean;
  /** Per-file and per-resource evidence, kept apart from `authority`. */
  provenance?: CoreWorkspaceReadProvenance;
}

export interface CoreWorkspaceProjectionCapture {
  captureSidebar(
    result: SidebarItemsFile,
    detail?: CoreWorkspaceReadDetail,
  ): void;
  captureConfig(
    result: WorkspaceConfigFile,
    detail?: CoreWorkspaceReadDetail,
  ): void;
  captureWorktrees(
    result: WorktreeData[],
    detail?: CoreWorkspaceReadDetail,
  ): void;
  captureWorktree(result: WorktreeData, detail?: CoreWorkspaceReadDetail): void;
  /**
   * Called after a list's legacy capture when its rows span more than one
   * page, before canonical projection or pinning. A legacy read that never
   * pages throws here to end the request without a snapshot (CAN-7181).
   */
  listingSpansPages?(): void;
}

/** Direct adapter calls (tests) have no dispatcher context. */
type CoreWorkspaceReadContext =
  | Pick<CanopyHandlerContext, 'caller'>
  | undefined;

type WorkspaceReadHandlers = Pick<
  CanopyQueryHandlerMap<CoreWorkspaceReadContext>,
  | 'core.workspace.list'
  | 'core.workspace.get'
  | 'core.worktree.list'
  | 'core.worktree.get'
>;

/** The legacy capture a listing published, republished with each later page. */
type PinnedLegacyCapture =
  | {
      readonly kind: 'sidebar';
      readonly result: SidebarItemsFile;
      readonly detail?: CoreWorkspaceReadDetail;
    }
  | {
      readonly kind: 'worktrees';
      readonly result: WorktreeData[];
      readonly detail?: CoreWorkspaceReadDetail;
    };

interface PinnedListBase<Operation extends CoreReadSnapshotOperation, Item> {
  readonly operation: Operation;
  readonly items: Item[];
  readonly collectionRevision?: number;
  readonly legacy: PinnedLegacyCapture;
}

export type CoreWorkspacePinnedList =
  | PinnedListBase<'core.workspace.list', CoreWorkspace>
  | PinnedListBase<'core.worktree.list', CoreWorktree>;

export type CoreWorkspaceReadSnapshots =
  CoreReadSnapshotStore<CoreWorkspacePinnedList>;

/** Runtime-owned list snapshots; the owner calls `close()` at teardown. */
export function createCoreWorkspaceReadSnapshots(
  limits?: CoreReadSnapshotLimits,
  now?: () => number,
): CoreWorkspaceReadSnapshots {
  return createCoreReadSnapshotStore<CoreWorkspacePinnedList>(limits, now);
}

async function checkWorktreeWorkspaceId(
  workspaceId: string,
  services: CoreWorkspaceReadServices,
): Promise<void> {
  if (!(await readIndexEntry(services, workspaceId))) throw worktreeNotFound();
}

/** The `core.worktree.get` projection of one row, before its revision. */
export function projectWorktree(
  workspaceId: string,
  worktree: WorktreeData,
): CoreWorktree {
  return projectCoreWorktree(workspaceId, worktree);
}

function publishLegacy(
  capture: CoreWorkspaceProjectionCapture | undefined,
  legacy: PinnedLegacyCapture,
): void {
  if (legacy.kind === 'sidebar')
    capture?.captureSidebar(legacy.result, legacy.detail);
  else capture?.captureWorktrees(legacy.result, legacy.detail);
}

interface SidebarRead {
  file: SidebarItemsFile;
  detail?: CoreWorkspaceReadDetail;
  indexedWorkspaceIds?: readonly string[];
  workspaceReads?: ReadonlyMap<string, SidebarWorkspaceReads>;
  /** One per `file.items` entry, at the same position. */
  storedFields?: readonly SidebarWorkspaceStoredFields[];
}

async function readSidebar(
  services: CoreWorkspaceReadServices,
): Promise<SidebarRead> {
  if (!services.readAllSidebarItemsSnapshot)
    return { file: await services.readAllSidebarItems() };
  const {
    file,
    authority,
    indexAuthority,
    indexedWorkspaceIds,
    workspaceReads,
    storedFields,
  } = await services.readAllSidebarItemsSnapshot();
  const projectedWorkspaceIds = new Set(file.items.map((item) => item.id));
  const worktreePreserveWorkspaceIds = new Set(
    (indexedWorkspaceIds ?? []).filter(
      (workspaceId) => !projectedWorkspaceIds.has(workspaceId),
    ),
  );
  for (const [workspaceId, reads] of workspaceReads ?? []) {
    if (reads.worktrees === 'unreadable' || reads.worktrees === 'partial')
      worktreePreserveWorkspaceIds.add(workspaceId);
  }
  return {
    file,
    detail: {
      authority,
      ...(indexAuthority ? { indexAuthority } : {}),
      ...(worktreePreserveWorkspaceIds.size > 0
        ? { worktreePreserveWorkspaceIds: [...worktreePreserveWorkspaceIds] }
        : {}),
    },
    ...(indexedWorkspaceIds ? { indexedWorkspaceIds } : {}),
    ...(workspaceReads ? { workspaceReads } : {}),
    ...(storedFields ? { storedFields } : {}),
  };
}

/**
 * The discovery read as the shared projection takes it. Plain reads report
 * no authority, so their manifests project as read; a reporting read proves
 * only the manifests it read `ok`. Load warnings mark workspaces unprojected.
 */
function sharedSidebarRead(
  sidebar: SidebarRead,
): CoreWorkspaceSidebarRead<WorktreeData> {
  const reported = sidebar.detail !== undefined;
  return {
    indexAuthority: sidebar.detail?.indexAuthority ?? sidebar.detail?.authority,
    indexedWorkspaceIds: sidebar.indexedWorkspaceIds,
    unprojected: (sidebar.file.warnings?.length ?? 0) > 0,
    workspaces: sidebar.file.items.map((item, position) => {
      const reads = sidebar.workspaceReads?.get(item.id);
      // Paired by position, not id: duplicate-id rows keep their own fields.
      const stored = sidebar.storedFields?.[position];
      const manifestProven = reported ? reads?.manifest === 'ok' : true;
      return {
        index: {
          id: item.id,
          name: item.name,
          type: item.type,
          color: item.color,
          collapsed: item.collapsed,
          pinned: item.pinned,
          activitySectionOrder:
            item.type === 'cowork' ? undefined : item.activitySectionOrder,
        },
        indexStored: stored?.index,
        manifestAuthority: reads?.manifest,
        ...(manifestProven
          ? {
              manifest: {
                fields: {
                  itemSortMode: item.itemSortMode,
                  alwaysShow: item.alwaysShow,
                  startPage:
                    item.type === 'cowork' ? undefined : item.startPage,
                },
                stored: stored?.manifest,
              },
            }
          : {}),
        organizationId: item.owner?.organizationId,
        repositories: item.type === 'multi-repo' ? item.repos : [],
        sourceRepoPath:
          item.type === 'multi-repo' ? item.sourceRepoPath : undefined,
        ...(item.type === 'cowork'
          ? {}
          : {
              worktrees: {
                rows: item.worktrees,
                authority: reads?.worktrees,
                // Any reported tombstone list marks it, even an empty one;
                // a scoped list read needs at least one id.
                recentlyRemoved:
                  reads?.recentlyRemovedWorktreeIds !== undefined,
              },
            }),
      };
    }),
  };
}

async function readIndexEntry(
  services: Pick<
    CoreWorkspaceReadServices,
    'readWorkspaceIndexEntry' | 'readWorkspaceIndexEntryDetailed'
  >,
  workspaceId: string,
): Promise<{
  entry: WorkspaceIndexEntry;
  storedFields?: StoredWorkspaceIndexFields;
} | null> {
  if (services.readWorkspaceIndexEntryDetailed)
    return services.readWorkspaceIndexEntryDetailed(workspaceId);
  const entry = await services.readWorkspaceIndexEntry(workspaceId);
  return entry ? { entry } : null;
}

async function readConfig(
  services: Pick<
    CoreWorkspaceReadServices,
    'readWorkspaceConfig' | 'readWorkspaceConfigDetailed'
  >,
  workspaceId: string,
): Promise<{
  config: WorkspaceConfigFile;
  detail?: CoreWorkspaceReadDetail;
  storedFields?: StoredWorkspaceManifestFields;
}> {
  if (!services.readWorkspaceConfigDetailed)
    return { config: await services.readWorkspaceConfig(workspaceId) };
  const { config, authority, ownerMalformed, storedFields } =
    await services.readWorkspaceConfigDetailed(workspaceId);
  return {
    config,
    detail: { authority, ownerMalformed },
    ...(storedFields ? { storedFields } : {}),
  };
}

async function readWorktrees(
  services: CoreWorkspaceReadServices,
  workspaceId: string,
): Promise<{
  worktrees: WorktreeData[];
  detail?: CoreWorkspaceReadDetail;
  recentlyRemoved: boolean;
}> {
  if (!services.readWorkspaceWorktreesDetailed)
    return {
      worktrees: await services.readWorkspaceWorktrees(workspaceId),
      recentlyRemoved: false,
    };
  const { worktrees, authority, recentlyRemovedWorktreeIds } =
    await services.readWorkspaceWorktreesDetailed(workspaceId);
  return {
    worktrees,
    detail: { authority },
    recentlyRemoved: (recentlyRemovedWorktreeIds?.length ?? 0) > 0,
  };
}

const DISCOVER_WORKSPACES: W5CaptureRequest = {
  files: [],
  discoverWorkspaces: true,
};

/** The index and one workspace's `files`. */
function workspaceCapture(
  workspaceId: string,
  files: readonly ('manifest' | 'worktrees')[],
): W5CaptureRequest {
  return {
    discoverWorkspaces: false,
    files: [{ kind: 'index' }, ...files.map((kind) => ({ kind, workspaceId }))],
  };
}

function withReadView<T>(
  services: CoreWorkspaceReadServices,
  request: W5CaptureRequest,
  work: (view?: W5ReadViewOutcome) => Promise<T>,
): Promise<T> {
  return services.readView
    ? services.readView(request, (view) => {
        if (view?.status === 'uncaptured' && view.error) throw view.error;
        return work(view);
      })
    : work();
}

function withProvenance(
  detail: CoreWorkspaceReadDetail | undefined,
  view: W5ReadViewOutcome | undefined,
  resultFilters: CoreWorkspaceFilters,
  resources: readonly CoreWorkspaceResourceProjection[],
): CoreWorkspaceReadDetail | undefined {
  if (!detail || !view) return detail;
  return {
    ...detail,
    provenance: projectReadProvenance(view, resultFilters, resources),
  };
}

function withSelectionProvenance(
  detail: CoreWorkspaceReadDetail | undefined,
  view: W5ReadViewOutcome | undefined,
  selection: Pick<CoreWorkspaceSelection<unknown>, 'filters' | 'resources'>,
): CoreWorkspaceReadDetail | undefined {
  return withProvenance(detail, view, selection.filters, selection.resources);
}

/**
 * One workspace's `core.workspace.get` row, before its revision. Its
 * repository sources come from the source overlay, outside W5.
 */
async function projectIndexedWorkspace(
  services: Pick<CoreWorkspaceReadServices, 'readEffectiveWorkspaceConfig'>,
  indexRead: NonNullable<Awaited<ReturnType<typeof readIndexEntry>>>,
  manifest: Awaited<ReturnType<typeof readConfig>>,
): Promise<CoreWorkspaceProjectedRow<CoreWorkspace>> {
  const { config, detail, storedFields } = manifest;
  const effective = await services.readEffectiveWorkspaceConfig(
    indexRead.entry.id,
    config,
  );
  return projectCoreWorkspaceGetRow(
    { entry: indexRead.entry, stored: indexRead.storedFields },
    {
      authority: detail?.authority,
      repositories: effective.repos,
      fields: config,
      stored: storedFields,
    },
  );
}

/**
 * The `core.workspace.get` projection of one workspace, without a read view
 * or a revision, or null when the index has no such workspace: what
 * `core.workspace.update` answers (W7a, DM-2). Inside a W5 decision's scope
 * the reads see the files it staged.
 */
export async function readDecidedCoreWorkspace(
  workspaceId: string,
): Promise<CoreWorkspace | null> {
  const services = {
    readWorkspaceIndexEntry,
    readWorkspaceIndexEntryDetailed,
    readWorkspaceConfig,
    readWorkspaceConfigDetailed,
    readEffectiveWorkspaceConfig,
  };
  const indexRead = await readIndexEntry(services, workspaceId);
  if (!indexRead) return null;
  return (
    await projectIndexedWorkspace(
      services,
      indexRead,
      await readConfig(services, workspaceId),
    )
  ).item;
}

// Client reads never persist removal cleanup (RR1); list writes do.
export function defaultCoreWorkspaceReadServices(): CoreWorkspaceReadServices {
  return {
    readAllSidebarItems: () =>
      readAllSidebarItems({ persistRemovalCleanup: false }),
    readWorkspaceIndexEntry: (workspaceId) =>
      readWorkspaceIndexEntry(workspaceId),
    readWorkspaceIndexEntryDetailed: (workspaceId) =>
      readWorkspaceIndexEntryDetailed(workspaceId),
    readWorkspaceConfig: (workspaceId) => readWorkspaceConfig(workspaceId),
    readWorkspaceWorktrees: (workspaceId) =>
      readWorkspaceWorktrees(workspaceId, { persistRemovalCleanup: false }),
    readEffectiveWorkspaceConfig: (workspaceId, config) =>
      readEffectiveWorkspaceConfig(workspaceId, config),
    readAllSidebarItemsSnapshot: () =>
      readAllSidebarItemsSnapshot({ persistRemovalCleanup: false }),
    readWorkspaceConfigDetailed: (workspaceId) =>
      readWorkspaceConfigDetailed(workspaceId),
    readWorkspaceWorktreesDetailed: (workspaceId) =>
      readWorkspaceWorktreesDetailed(workspaceId, {
        persistRemovalCleanup: false,
      }),
    readView: runW5ReadView,
  };
}

const UNVERIFIED_EVIDENCE: W5RevisionEligibility = {
  status: 'unverified',
  reason: 'evidence-unavailable',
};

export interface WorktreeRevisionEvidence {
  readonly eligibility: W5RevisionEligibility;
  /**
   * The captured list's fingerprint when its provenance is canonical, which
   * a decision's preimage must match; absent otherwise.
   */
  readonly listFingerprint?: string | null;
}

/**
 * The revision eligibility a scoped `core.worktree.get` classifies for one
 * row, from the same capture and list read, or null when the list has no
 * such row. Read-only: a guarded command's DP-1 precondition (W7b-1b).
 */
export function readWorktreeRevisionEvidence(
  workspaceId: string,
  worktreeId: string,
  services: CoreWorkspaceReadServices = defaultCoreWorkspaceReadServices(),
): Promise<WorktreeRevisionEvidence | null> {
  return withReadView(
    services,
    workspaceCapture(workspaceId, ['worktrees']),
    async (view) => {
      const { worktrees, detail } = await readWorktrees(services, workspaceId);
      const worktree = worktrees.find((entry) => entry.id === worktreeId);
      if (!worktree) return null;
      const provenance = withSelectionProvenance(
        detail,
        view,
        selectCoreWorktreeGet(workspaceId, worktree),
      )?.provenance;
      const list = provenance?.files.find(
        ({ file }) =>
          file.kind === 'worktrees' &&
          'workspaceId' in file &&
          file.workspaceId === workspaceId,
      )?.provenance;
      return {
        eligibility:
          provenance?.resources[0]?.eligibility ?? UNVERIFIED_EVIDENCE,
        ...(list?.status === 'canonical' && {
          listFingerprint: list.fingerprint,
        }),
      };
    },
  );
}

export function createCoreWorkspaceAdapter(
  services: CoreWorkspaceReadServices = defaultCoreWorkspaceReadServices(),
  capture?: CoreWorkspaceProjectionCapture,
  snapshots: CoreWorkspaceReadSnapshots = createCoreWorkspaceReadSnapshots(),
): WorkspaceReadHandlers {
  /**
   * Projects a listing's first page and pins a listing that spans pages.
   * Such a listing first lets the capture end the read, before projecting
   * its `total` rows.
   */
  const firstPage = <Item>(
    binding: CoreReadSnapshotBinding,
    total: number,
    project: () => CoreWorkspacePinnedList & { readonly items: Item[] },
  ): CoreWorkspaceListPage<Item> => {
    if (total > binding.pageSize) capture?.listingSpansPages?.();
    const pinned = project();
    return listPage(
      pinned,
      0,
      binding.pageSize,
      isW5ProjectionOnlyView()
        ? null
        : snapshots.open(binding, pinned, pinned.items.length),
    );
  };
  return {
    'core.workspace.list': async (
      params: CanopyQueryParams<'core.workspace.list'>,
      context: CoreWorkspaceReadContext,
    ): Promise<CanopyQueryResult<'core.workspace.list'>> => {
      checkCoreWorkspaceListParams(params, LOCAL_DESKTOP_AUTHORITY_ID);
      const binding = listBinding(
        'core.workspace.list',
        params,
        context?.caller,
      );
      if (params.cursor !== undefined) {
        // Refused before anything is published, so no legacy fallback applies.
        const page = snapshots.resume(params.cursor, binding);
        if (page.pinned.operation !== 'core.workspace.list')
          throw differentListing();
        publishLegacy(capture, page.pinned.legacy);
        return listPage(
          page.pinned,
          page.offset,
          binding.pageSize,
          page.nextCursor,
        );
      }
      return withReadView(services, DISCOVER_WORKSPACES, async (view) => {
        const sidebar = await readSidebar(services);
        const selection = selectCoreWorkspaceList(
          sharedSidebarRead(sidebar),
          params.scope,
          binding.pageSize,
        );
        const detail = withSelectionProvenance(sidebar.detail, view, selection);
        capture?.captureSidebar(sidebar.file, detail);
        return firstPage(binding, selection.total, () => ({
          operation: 'core.workspace.list',
          ...publishCoreWorkspaceList(
            selection.project(),
            publishableRevisions(detail?.provenance),
          ),
          legacy: { kind: 'sidebar', result: sidebar.file, detail },
        }));
      });
    },
    'core.workspace.get': async (
      params: CanopyQueryParams<'core.workspace.get'>,
    ): Promise<CanopyQueryResult<'core.workspace.get'>> => {
      // A cloud project's settings revision (CAN-6093); desktop advertises none.
      if (params.revision !== undefined)
        throw new CanopyOperationError({
          kind: 'capability_unavailable',
          message: 'Desktop workspaces do not serve this revision.',
          details: { unsupported: ['revision'], reason: 'unserved' },
          retry: {
            kind: 'after_refresh',
            resource: 'core.runtime.manifest.get',
          },
        });
      checkCoreWorkspaceGetParams(params, LOCAL_DESKTOP_AUTHORITY_ID);
      const { workspaceId } = params;
      return withReadView(
        services,
        workspaceCapture(workspaceId, ['manifest']),
        async (view) => {
          // The index lookup stays first: it keeps unknown ids off the config path.
          const indexRead = await readIndexEntry(services, workspaceId);
          if (!indexRead) throw workspaceNotFound();
          const manifest = await readConfig(services, workspaceId);
          const { config, detail } = manifest;
          const readDetail = withProvenance(
            detail,
            view,
            [],
            coreWorkspaceGetResources(workspaceId, {
              authority: detail?.authority,
              type: config.type,
              sourceRepoPath: config.sourceRepoPath,
            }),
          );
          capture?.captureConfig(config, readDetail);
          checkCoreWorkspaceOrganization(
            params.scope,
            config.owner?.organizationId,
          );
          const { item } = await projectIndexedWorkspace(
            services,
            indexRead,
            manifest,
          );
          // Under the requested id, the resource its provenance names.
          return publishCoreWorkspaceItem(
            { item, resource: { kind: 'workspace', workspaceId } },
            publishableRevisions(readDetail?.provenance),
          );
        },
      );
    },
    'core.worktree.list': async (
      params: CanopyQueryParams<'core.worktree.list'>,
      context: CoreWorkspaceReadContext,
    ): Promise<CanopyQueryResult<'core.worktree.list'>> => {
      checkCoreWorktreeListParams(params, LOCAL_DESKTOP_AUTHORITY_ID);
      const workspaceId = params.scope?.workspaceId;
      const organizationId = params.scope?.organizationId;
      const binding = listBinding(
        'core.worktree.list',
        params,
        context?.caller,
      );
      if (params.cursor !== undefined) {
        // Refused before anything is published, so no legacy fallback applies.
        const page = snapshots.resume(params.cursor, binding);
        if (page.pinned.operation !== 'core.worktree.list')
          throw differentListing();
        publishLegacy(capture, page.pinned.legacy);
        return listPage(
          page.pinned,
          page.offset,
          binding.pageSize,
          page.nextCursor,
        );
      }
      if (workspaceId) {
        return withReadView(
          services,
          workspaceCapture(
            workspaceId,
            organizationId ? ['worktrees', 'manifest'] : ['worktrees'],
          ),
          async (view) => {
            await checkWorktreeWorkspaceId(workspaceId, services);
            const { worktrees, detail, recentlyRemoved } = await readWorktrees(
              services,
              workspaceId,
            );
            const config = organizationId
              ? await services.readWorkspaceConfig(workspaceId)
              : undefined;
            const selection = selectCoreWorkspaceWorktreeList(
              workspaceId,
              {
                rows: worktrees,
                authority: detail?.authority,
                recentlyRemoved,
              },
              config?.owner?.organizationId,
              params.scope,
              binding.pageSize,
            );
            const readDetail = withSelectionProvenance(detail, view, selection);
            capture?.captureWorktrees(worktrees, readDetail);
            return firstPage(binding, selection.total, () => ({
              operation: 'core.worktree.list',
              ...publishCoreWorkspaceList(
                selection.project(),
                publishableRevisions(readDetail?.provenance),
              ),
              legacy: {
                kind: 'worktrees',
                result: worktrees,
                detail: readDetail,
              },
            }));
          },
        );
      }
      return withReadView(services, DISCOVER_WORKSPACES, async (view) => {
        const sidebar = await readSidebar(services);
        const selection = selectCoreWorktreeListAcrossWorkspaces(
          sharedSidebarRead(sidebar),
          params.scope,
          binding.pageSize,
        );
        const detail = withSelectionProvenance(sidebar.detail, view, selection);
        capture?.captureSidebar(sidebar.file, detail);
        return firstPage(binding, selection.total, () => ({
          operation: 'core.worktree.list',
          ...publishCoreWorkspaceList(
            selection.project(),
            publishableRevisions(detail?.provenance),
          ),
          legacy: { kind: 'sidebar', result: sidebar.file, detail },
        }));
      });
    },
    'core.worktree.get': async (
      params: CanopyQueryParams<'core.worktree.get'>,
    ): Promise<CanopyQueryResult<'core.worktree.get'>> => {
      checkCoreWorktreeGetParams(params, LOCAL_DESKTOP_AUTHORITY_ID);
      const workspaceId = params.scope?.workspaceId;
      const organizationId = params.scope?.organizationId;
      if (workspaceId) {
        return withReadView(
          services,
          workspaceCapture(
            workspaceId,
            organizationId !== undefined
              ? ['worktrees', 'manifest']
              : ['worktrees'],
          ),
          async (view) => {
            await checkWorktreeWorkspaceId(workspaceId, services);
            if (organizationId !== undefined) {
              const config = await services.readWorkspaceConfig(workspaceId);
              if (config.owner?.organizationId !== organizationId)
                throw worktreeNotFound();
            }
            const { worktrees, detail } = await readWorktrees(
              services,
              workspaceId,
            );
            const worktree = worktrees.find(
              (entry) => entry.id === params.worktreeId,
            );
            if (!worktree) throw worktreeNotFound();
            const selection = selectCoreWorktreeGet(workspaceId, worktree);
            const readDetail = withSelectionProvenance(detail, view, selection);
            capture?.captureWorktree(worktree, readDetail);
            return publishCoreWorkspaceItem(
              selection.project(),
              publishableRevisions(readDetail?.provenance),
            );
          },
        );
      }
      return withReadView(services, DISCOVER_WORKSPACES, async (view) => {
        const sidebar = await readSidebar(services);
        const match = findCoreWorktreeAcrossWorkspaces(
          sharedSidebarRead(sidebar),
          params.worktreeId,
          organizationId,
        );
        if (!match) throw worktreeNotFound();
        const selection = selectCoreWorktreeGet(match.workspaceId, match.row);
        const detail = withSelectionProvenance(sidebar.detail, view, selection);
        capture?.captureWorktree(match.row, detail);
        return publishCoreWorkspaceItem(
          selection.project(),
          publishableRevisions(detail?.provenance),
        );
      });
    },
  };
}
