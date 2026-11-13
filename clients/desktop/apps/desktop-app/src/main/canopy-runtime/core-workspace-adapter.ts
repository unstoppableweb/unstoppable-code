import { isDeepStrictEqual } from 'node:util';
import type { z } from 'zod';
import type {
  CanopyQueryHandlerMap,
  CanopyQueryParams,
  CanopyQueryResult,
  CanopyWorkspaceScope,
  CoreWorkspace,
  CoreWorktree,
} from '@canopy/protocol/canopy-core';
import {
  CoreWorkspaceSchema,
  hasHostAbsolutePath,
} from '@canopy/protocol/canopy-core';
import type {
  SidebarItem,
  SidebarItemsFile,
  WorktreeData,
  WorkspaceConfigFile,
  WorkspaceIndexEntry,
} from '@canopy/desktop-shared/types';
import { PROJECT_COLORS } from '@canopy/desktop-shared/constants/project-colors';
import { isProjectStartPage } from '@canopy/protocol/start-page';
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
import { sanitizeRemoteUrl } from '../lib/plan-share-repos';
import { isW5ProjectionOnlyView } from '../lib/w5-fallback-read';
import { runW5ReadView } from '../lib/w5-commit-log-file-store';
import type { W5ReadViewOutcome } from '../lib/w5-read-view';
import type { W5CaptureRequest } from '../w5-commit-log/commit-log-worker-contract';
import type { W5RevisionEligibility } from '@canopy/core-runtime/node/w5/commit-log/eligibility';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';
import {
  coreWorkspaceResourceKey,
  isPartialPage,
  projectReadProvenance,
  publishableRevisions,
  type CoreWorkspaceExternalField,
  type CoreWorkspaceReadFilter,
  type CoreWorkspaceReadProvenance,
  type CoreWorkspaceResourceProjection,
} from './core-workspace-read-provenance';
import {
  createCoreReadSnapshotStore,
  type CoreReadSnapshotBinding,
  type CoreReadSnapshotLimits,
  type CoreReadSnapshotOperation,
  type CoreReadSnapshotStore,
} from '@canopy/core-runtime/node/workspace/core-workspace-read-snapshots';

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

const DEFAULT_PAGE_SIZE = 100;

function checkScope(scope?: CanopyWorkspaceScope): void {
  if (
    scope?.targetId !== undefined ||
    (scope?.authorityId !== undefined &&
      scope.authorityId !== LOCAL_DESKTOP_AUTHORITY_ID)
  ) {
    throw new CanopyOperationError({
      kind: 'capability_unavailable',
      message: 'The selected workspace authority or target is unavailable.',
      retry: { kind: 'never' },
    });
  }
}

function checkWorkspaceScope(scope?: CanopyWorkspaceScope): void {
  if (
    scope?.worktreeId !== undefined ||
    scope?.chatId !== undefined ||
    scope?.operationId !== undefined ||
    scope?.executionId !== undefined ||
    scope?.repoId !== undefined
  ) {
    throw new CanopyOperationError({
      kind: 'capability_unavailable',
      message: 'The selected workspace scope is unavailable.',
      retry: { kind: 'never' },
    });
  }
}

function invalidArgument(message: string): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'invalid_argument',
    message,
    retry: { kind: 'never' },
  });
}

function checkWorkspaceIdSpelling(workspaceId?: string): void {
  if (workspaceId !== undefined && hasHostAbsolutePath(workspaceId)) {
    throw invalidArgument('Workspace ids cannot be host paths.');
  }
}

function checkWorktreeScope(scope?: CanopyWorkspaceScope): void {
  if (
    scope?.chatId !== undefined ||
    scope?.operationId !== undefined ||
    scope?.executionId !== undefined ||
    scope?.repoId !== undefined
  ) {
    throw new CanopyOperationError({
      kind: 'capability_unavailable',
      message: 'The selected worktree scope is unavailable.',
      retry: { kind: 'never' },
    });
  }
}

function workspaceNotFound(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'not_found',
    message: 'Workspace not found.',
    retry: { kind: 'never' },
  });
}

const MAX_REPO_ID_LENGTH = 512;

function worktreeNotFound(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'not_found',
    message: 'Worktree not found.',
    retry: { kind: 'never' },
  });
}

/** Refuses traversal spellings before any capture or read. */
function checkWorktreeWorkspaceIdSpelling(workspaceId: string): void {
  if (
    workspaceId === '.' ||
    workspaceId === '..' ||
    workspaceId.includes('/') ||
    workspaceId.includes('\\')
  ) {
    throw worktreeNotFound();
  }
}

async function checkWorktreeWorkspaceId(
  workspaceId: string,
  services: CoreWorkspaceReadServices,
): Promise<void> {
  if (!(await readIndexEntry(services, workspaceId))) throw worktreeNotFound();
}

function projectRepositorySources(
  repos: readonly { id: string; manifestUrl?: string | null }[],
): CoreWorkspace['repositorySources'] {
  // Legacy persistence accepts any id length; the legacy helpers fall back.
  if (repos.some((repo) => repo.id.length > MAX_REPO_ID_LENGTH)) {
    throw invalidArgument('Workspace repository id exceeds 512 characters.');
  }
  return repos.flatMap((repo) => {
    const remoteUrl = sanitizeRemoteUrl(repo.manifestUrl ?? null);
    return remoteUrl &&
      remoteUrl.length <= 4096 &&
      !hasHostAbsolutePath(remoteUrl)
      ? [{ repoId: repo.id, remoteUrl }]
      : [];
  });
}

type CoreWorkspaceTypedFields = Pick<
  CoreWorkspace,
  | 'color'
  | 'pinned'
  | 'collapsed'
  | 'itemSortMode'
  | 'activitySectionOrder'
  | 'alwaysShow'
  | 'startPage'
>;

const TYPED_FIELD_SCHEMAS = CoreWorkspaceSchema.shape;

/**
 * A stored value outside the patch schema is omitted, never coerced: one the
 * schema would rewrite (`z.url()` trims) would not be the stored edit baseline.
 */
function storedValue<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success && isDeepStrictEqual(parsed.data, value)
    ? parsed.data
    : undefined;
}

/**
 * What a typed field projects from: the stored value when the read reports
 * one (`null` included), so a malformed value is omitted instead of read as
 * the default the reader substitutes; otherwise the read's own value, and
 * `whenUnset` when the field is unset.
 */
function fieldSource<Key extends string>(
  key: Key,
  read: Partial<Record<Key, unknown>>,
  stored: Readonly<Partial<Record<Key, unknown>>> | undefined,
  whenUnset?: unknown,
): unknown {
  const value = stored?.[key];
  if (value !== undefined) return value;
  return read[key] === undefined ? whenUnset : read[key];
}

/** Only palette colors: the update refuses any other (`Invalid project color`). */
function isProjectColor(color: string): boolean {
  return PROJECT_COLORS.some((candidate) => candidate === color);
}

/** Cowork has no activity section order. */
function indexTypedFields(
  index: Pick<
    WorkspaceIndexEntry,
    'type' | 'color' | 'collapsed' | 'pinned' | 'activitySectionOrder'
  >,
  stored: StoredWorkspaceIndexFields | undefined,
): CoreWorkspaceTypedFields {
  const fields: CoreWorkspaceTypedFields = {};
  const source = (
    key: keyof StoredWorkspaceIndexFields,
    whenUnset?: unknown,
  ): unknown => fieldSource(key, index, stored, whenUnset);
  const color = storedValue(TYPED_FIELD_SCHEMAS.color, source('color'));
  if (color !== undefined && isProjectColor(color)) fields.color = color;
  const pinned = storedValue(
    TYPED_FIELD_SCHEMAS.pinned,
    source('pinned', false),
  );
  if (pinned !== undefined) fields.pinned = pinned;
  const collapsed = storedValue(
    TYPED_FIELD_SCHEMAS.collapsed,
    source('collapsed'),
  );
  if (collapsed !== undefined) fields.collapsed = collapsed;
  if (index.type === 'cowork') return fields;
  // Repeated ids read as the rendered order, where the first one wins; an
  // unknown id is omitted with the order, since dropping it would edit it.
  const order = source('activitySectionOrder', []);
  const sections = storedValue(
    TYPED_FIELD_SCHEMAS.activitySectionOrder,
    Array.isArray(order) ? Array.from(new Set(order)) : order,
  );
  if (sections !== undefined) fields.activitySectionOrder = sections;
  return fields;
}

/** Cowork keeps its start page in its Cowork settings. */
function manifestTypedFields(
  type: WorkspaceIndexEntry['type'],
  manifest: Pick<
    WorkspaceConfigFile,
    'itemSortMode' | 'alwaysShow' | 'startPage'
  >,
  stored: StoredWorkspaceManifestFields | undefined,
): CoreWorkspaceTypedFields {
  const fields: CoreWorkspaceTypedFields = {};
  const source = (key: keyof StoredWorkspaceManifestFields): unknown =>
    fieldSource(key, manifest, stored);
  const sortMode = storedValue(
    TYPED_FIELD_SCHEMAS.itemSortMode,
    source('itemSortMode'),
  );
  if (sortMode !== undefined) fields.itemSortMode = sortMode;
  // Unset only on a temporary combination: shown, but retired when empty.
  const alwaysShow = storedValue(
    TYPED_FIELD_SCHEMAS.alwaysShow,
    source('alwaysShow'),
  );
  if (alwaysShow !== undefined) fields.alwaysShow = alwaysShow;
  if (type === 'cowork') return fields;
  // A set start page also passes the update's own rule (`isProjectStartPage`).
  const page = source('startPage');
  const startPage =
    page === undefined
      ? { kind: 'inherit' as const }
      : page === null || isProjectStartPage(page)
        ? storedValue(TYPED_FIELD_SCHEMAS.startPage, page)
        : undefined;
  if (startPage !== undefined) fields.startPage = startPage;
  return fields;
}

interface TypedFieldReads {
  index: Parameters<typeof indexTypedFields>[0];
  indexStored?: StoredWorkspaceIndexFields;
  /** Only from a read that proved the manifest. */
  manifest?: Parameters<typeof manifestTypedFields>[1];
  manifestStored?: StoredWorkspaceManifestFields;
}

/**
 * The `core.workspace.update` patch fields as stored, so each is a valid edit
 * baseline: the index entry's always, the manifest's only from a read that
 * proved its contents (an absent or unreadable manifest reads as defaults).
 * A field whose stored value the update would refuse is omitted.
 */
function projectTypedFields({
  index,
  indexStored,
  manifest,
  manifestStored,
}: TypedFieldReads): CoreWorkspaceTypedFields {
  return {
    ...indexTypedFields(index, indexStored),
    ...(manifest
      ? manifestTypedFields(index.type, manifest, manifestStored)
      : {}),
  };
}

/**
 * Plain reads report no authority; their manifest is projected as read. A
 * reporting read without this manifest's authority has not proved it.
 */
function manifestProven(
  authority: CoreWorkspaceReadAuthority | undefined,
  reported: boolean,
): boolean {
  return reported ? authority === 'ok' : true;
}

function projectWorkspace(
  item: SidebarItem,
  manifestIsProven: boolean,
  stored: SidebarWorkspaceStoredFields | undefined,
): CoreWorkspace {
  const repos = item.type === 'multi-repo' ? item.repos : [];
  return {
    workspaceId: item.id,
    name: item.name,
    kind: item.type === 'cowork' ? 'cowork' : 'git',
    repositorySources: projectRepositorySources(repos),
    settings: {},
    ...projectTypedFields({
      index: {
        type: item.type,
        color: item.color,
        collapsed: item.collapsed,
        pinned: item.pinned,
        activitySectionOrder:
          item.type === 'cowork' ? undefined : item.activitySectionOrder,
      },
      indexStored: stored?.index,
      ...(manifestIsProven
        ? {
            manifest: {
              itemSortMode: item.itemSortMode,
              alwaysShow: item.alwaysShow,
              startPage: item.type === 'cowork' ? undefined : item.startPage,
            },
            manifestStored: stored?.manifest,
          }
        : {}),
    }),
  };
}

/** The `core.worktree.get` projection of one row, before its revision. */
export function projectWorktree(
  workspaceId: string,
  worktree: WorktreeData,
): CoreWorktree {
  return {
    worktreeId: worktree.id,
    workspaceId,
    name: worktree.label || worktree.branchName,
    state: worktree.healthIssue
      ? 'error'
      : worktree.setupPhase === 'git-pending'
        ? 'creating'
        : 'ready',
    baseBranch: worktree.trackedBaseBranch ?? null,
    branch: worktree.branchName,
    createdAt: worktree.createdAt,
  };
}

function withRevision<T extends object>(item: T, revision?: number): T {
  return revision === undefined ? item : { ...item, revision };
}

// A type literal, so it takes the result schema's catchall index signature.
type ListPage<Item> = {
  items: Item[];
  nextCursor: string | null;
  collectionRevision?: number;
};

function listPage<Item>(
  pinned: { readonly items: Item[]; readonly collectionRevision?: number },
  offset: number,
  pageSize: number,
  nextCursor: string | null,
): ListPage<Item> {
  return {
    items: pinned.items.slice(offset, offset + pageSize),
    nextCursor,
    // Every page of a listing carries the first page's collection revision.
    ...(pinned.collectionRevision === undefined
      ? {}
      : { collectionRevision: pinned.collectionRevision }),
  };
}

function listBinding(
  operation: CoreReadSnapshotOperation,
  params: { scope?: CanopyWorkspaceScope; pageSize?: number },
  context: CoreWorkspaceReadContext,
): CoreReadSnapshotBinding {
  return {
    operation,
    scope: {
      workspaceId: params.scope?.workspaceId,
      organizationId: params.scope?.organizationId,
      worktreeId: params.scope?.worktreeId,
    },
    pageSize: params.pageSize ?? DEFAULT_PAGE_SIZE,
    ...(context?.caller ? { caller: context.caller } : {}),
  };
}

function publishLegacy(
  capture: CoreWorkspaceProjectionCapture | undefined,
  legacy: PinnedLegacyCapture,
): void {
  if (legacy.kind === 'sidebar')
    capture?.captureSidebar(legacy.result, legacy.detail);
  else capture?.captureWorktrees(legacy.result, legacy.detail);
}

function differentListing(): CanopyOperationError {
  return invalidArgument(
    'This list cursor belongs to a different listing. Repeat the scope and page size it was issued for.',
  );
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

type Filters = readonly (CoreWorkspaceReadFilter | false | undefined)[];

function withProvenance(
  detail: CoreWorkspaceReadDetail | undefined,
  view: W5ReadViewOutcome | undefined,
  resultFilters: Filters,
  resources: readonly CoreWorkspaceResourceProjection[],
): CoreWorkspaceReadDetail | undefined {
  if (!detail || !view) return detail;
  return {
    ...detail,
    provenance: projectReadProvenance(view, resultFilters, resources),
  };
}

/** A manifest read that could not prove its contents projects a default. */
function manifestFilters(
  authority: CoreWorkspaceReadAuthority | undefined,
): Filters {
  return [authority !== 'ok' && authority !== 'absent' && 'fallback'];
}

function listFilters(
  authority: CoreWorkspaceReadAuthority | undefined,
  recentlyRemoved: boolean,
): Filters {
  return [
    recentlyRemoved && 'recently-removed',
    authority === 'partial' && 'unreadable-entries',
    (authority === undefined || authority === 'unreadable') && 'fallback',
  ];
}

/** Index-level omissions; each workspace's own reads stay with its resources. */
function sidebarFilters(sidebar: SidebarRead): Filters {
  const index = sidebar.detail?.indexAuthority ?? sidebar.detail?.authority;
  return [
    (sidebar.indexedWorkspaceIds === undefined ||
      sidebar.file.items.length < sidebar.indexedWorkspaceIds.length ||
      (sidebar.file.warnings?.length ?? 0) > 0) &&
      'unprojected',
    index === 'partial' && 'unreadable-entries',
    (index === undefined || index === 'unreadable') && 'fallback',
  ];
}

/** Repository sources a source overlay can contribute (`readEffectiveWorkspaceConfig`). */
function sourceOverlayFields(config: {
  type?: string;
  sourceRepoPath?: string;
}): CoreWorkspaceExternalField[] {
  return config.type !== 'single-repo' && config.sourceRepoPath !== undefined
    ? ['repositorySources']
    : [];
}

/** One workspace's `core.workspace.get` projection, before its revision. */
async function projectIndexedWorkspace(
  services: Pick<CoreWorkspaceReadServices, 'readEffectiveWorkspaceConfig'>,
  indexRead: NonNullable<Awaited<ReturnType<typeof readIndexEntry>>>,
  manifest: Awaited<ReturnType<typeof readConfig>>,
): Promise<CoreWorkspace> {
  const { entry: index } = indexRead;
  const { config, detail, storedFields } = manifest;
  const effective = await services.readEffectiveWorkspaceConfig(
    index.id,
    config,
  );
  return {
    workspaceId: index.id,
    name: index.name,
    kind: index.type === 'cowork' ? 'cowork' : 'git',
    repositorySources: projectRepositorySources(effective.repos),
    settings: {},
    ...projectTypedFields({
      index,
      indexStored: indexRead.storedFields,
      ...(manifestProven(detail?.authority, detail !== undefined)
        ? { manifest: config, manifestStored: storedFields }
        : {}),
    }),
  };
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
  return projectIndexedWorkspace(
    services,
    indexRead,
    await readConfig(services, workspaceId),
  );
}

function worktreeResource(
  workspaceId: string,
  worktreeId: string,
): CoreWorkspaceResourceProjection {
  return { resource: { kind: 'worktree', workspaceId, worktreeId } };
}

// Client reads never persist removal cleanup (RR1); list writes do.
function defaultCoreWorkspaceReadServices(): CoreWorkspaceReadServices {
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
      if (!worktrees.some((entry) => entry.id === worktreeId)) return null;
      const provenance = withProvenance(
        detail,
        view,
        [],
        [worktreeResource(workspaceId, worktreeId)],
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
  /** Pins a listing that spans pages and returns its first page. */
  const firstPage = <Item>(
    binding: CoreReadSnapshotBinding,
    pinned: CoreWorkspacePinnedList & { readonly items: Item[] },
  ): ListPage<Item> =>
    listPage(
      pinned,
      0,
      binding.pageSize,
      isW5ProjectionOnlyView()
        ? null
        : snapshots.open(binding, pinned, pinned.items.length),
    );
  return {
    'core.workspace.list': async (
      params: CanopyQueryParams<'core.workspace.list'>,
      context: CoreWorkspaceReadContext,
    ): Promise<CanopyQueryResult<'core.workspace.list'>> => {
      checkScope(params.scope);
      checkWorkspaceScope(params.scope);
      checkWorkspaceIdSpelling(params.scope?.workspaceId);
      const binding = listBinding('core.workspace.list', params, context);
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
        // Paired by position, not id: duplicate-id rows keep their own fields.
        const rows = sidebar.file.items.flatMap((item, position) =>
          (params.scope?.workspaceId === undefined ||
            item.id === params.scope.workspaceId) &&
          (params.scope?.organizationId === undefined ||
            item.owner?.organizationId === params.scope.organizationId)
            ? [{ item, stored: sidebar.storedFields?.[position] }]
            : [],
        );
        const items = rows.map(({ item }) => item);
        const filters: Filters = [
          params.scope?.workspaceId !== undefined && 'workspace-scope',
          params.scope?.organizationId !== undefined && 'organization',
          ...sidebarFilters(sidebar),
        ];
        const detail = withProvenance(
          sidebar.detail,
          view,
          [...filters, isPartialPage(items.length, binding.pageSize) && 'page'],
          [
            { resource: { kind: 'workspaces' }, filters },
            ...items.map(
              (item): CoreWorkspaceResourceProjection => ({
                resource: { kind: 'workspace', workspaceId: item.id },
                filters: manifestFilters(
                  sidebar.workspaceReads?.get(item.id)?.manifest,
                ),
                external:
                  item.type === 'multi-repo' ? sourceOverlayFields(item) : [],
              }),
            ),
          ],
        );
        capture?.captureSidebar(sidebar.file, detail);
        const revisions = publishableRevisions(detail?.provenance);
        return firstPage(binding, {
          operation: 'core.workspace.list',
          items: rows.map(({ item, stored }) =>
            withRevision(
              projectWorkspace(
                item,
                manifestProven(
                  sidebar.workspaceReads?.get(item.id)?.manifest,
                  sidebar.detail !== undefined,
                ),
                stored,
              ),
              revisions.get(
                coreWorkspaceResourceKey({
                  kind: 'workspace',
                  workspaceId: item.id,
                }),
              ),
            ),
          ),
          collectionRevision: revisions.get(
            coreWorkspaceResourceKey({ kind: 'workspaces' }),
          ),
          legacy: { kind: 'sidebar', result: sidebar.file, detail },
        });
      });
    },
    'core.workspace.get': async (
      params: CanopyQueryParams<'core.workspace.get'>,
    ): Promise<CanopyQueryResult<'core.workspace.get'>> => {
      checkScope(params.scope);
      checkWorkspaceScope(params.scope);
      checkWorkspaceIdSpelling(params.workspaceId);
      checkWorkspaceIdSpelling(params.scope?.workspaceId);
      if (
        params.scope?.workspaceId !== undefined &&
        params.scope.workspaceId !== params.workspaceId
      ) {
        throw workspaceNotFound();
      }
      const { workspaceId } = params;
      return withReadView(
        services,
        workspaceCapture(workspaceId, ['manifest']),
        async (view) => {
          // The index lookup stays first: it keeps unknown ids off the config path.
          const indexRead = await readIndexEntry(services, workspaceId);
          if (!indexRead) throw workspaceNotFound();
          const { config, detail, storedFields } = await readConfig(
            services,
            workspaceId,
          );
          const resource = { kind: 'workspace', workspaceId } as const;
          const readDetail = withProvenance(
            detail,
            view,
            [],
            [
              {
                resource,
                filters: manifestFilters(detail?.authority),
                external: sourceOverlayFields(config),
              },
            ],
          );
          capture?.captureConfig(config, readDetail);
          if (
            params.scope?.organizationId !== undefined &&
            config.owner?.organizationId !== params.scope.organizationId
          ) {
            throw workspaceNotFound();
          }
          return withRevision(
            await projectIndexedWorkspace(services, indexRead, {
              config,
              detail,
              storedFields,
            }),
            publishableRevisions(readDetail?.provenance).get(
              coreWorkspaceResourceKey(resource),
            ),
          );
        },
      );
    },
    'core.worktree.list': async (
      params: CanopyQueryParams<'core.worktree.list'>,
      context: CoreWorkspaceReadContext,
    ): Promise<CanopyQueryResult<'core.worktree.list'>> => {
      checkScope(params.scope);
      checkWorktreeScope(params.scope);
      const workspaceId = params.scope?.workspaceId;
      const organizationId = params.scope?.organizationId;
      const worktreeId = params.scope?.worktreeId;
      if (workspaceId) checkWorktreeWorkspaceIdSpelling(workspaceId);
      const binding = listBinding('core.worktree.list', params, context);
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
            const rows = worktrees.filter(
              (worktree) =>
                (worktreeId === undefined || worktree.id === worktreeId) &&
                (organizationId === undefined ||
                  config?.owner?.organizationId === organizationId),
            );
            const filters: Filters = [
              worktreeId !== undefined && 'worktree-scope',
              organizationId !== undefined && 'organization',
              ...listFilters(detail?.authority, recentlyRemoved),
            ];
            const collection = { kind: 'worktrees', workspaceId } as const;
            const readDetail = withProvenance(
              detail,
              view,
              [
                ...filters,
                isPartialPage(rows.length, binding.pageSize) && 'page',
              ],
              [
                { resource: collection, filters },
                ...rows.map((row) => worktreeResource(workspaceId, row.id)),
              ],
            );
            capture?.captureWorktrees(worktrees, readDetail);
            const revisions = publishableRevisions(readDetail?.provenance);
            return firstPage(binding, {
              operation: 'core.worktree.list',
              items: rows.map((row) =>
                withRevision(
                  projectWorktree(workspaceId, row),
                  revisions.get(
                    coreWorkspaceResourceKey(
                      worktreeResource(workspaceId, row.id).resource,
                    ),
                  ),
                ),
              ),
              collectionRevision: revisions.get(
                coreWorkspaceResourceKey(collection),
              ),
              legacy: {
                kind: 'worktrees',
                result: worktrees,
                detail: readDetail,
              },
            });
          },
        );
      }
      return withReadView(services, DISCOVER_WORKSPACES, async (view) => {
        const sidebar = await readSidebar(services);
        const included = sidebar.file.items.flatMap((item) =>
          item.type === 'cowork' ||
          (organizationId !== undefined &&
            item.owner?.organizationId !== organizationId)
            ? []
            : [item],
        );
        const rows = included.flatMap((item) =>
          item.worktrees
            .filter(
              (worktree) =>
                worktreeId === undefined || worktree.id === worktreeId,
            )
            .map((worktree) => ({ workspaceId: item.id, worktree })),
        );
        // Each workspace's list is its own resource; no collection spans
        // them, so this aggregation publishes no collection revision.
        const collections = included.map(
          (item): CoreWorkspaceResourceProjection => {
            const reads = sidebar.workspaceReads?.get(item.id);
            return {
              resource: { kind: 'worktrees', workspaceId: item.id },
              filters: [
                worktreeId !== undefined && 'worktree-scope',
                ...listFilters(
                  reads?.worktrees,
                  reads?.recentlyRemovedWorktreeIds !== undefined,
                ),
              ],
            };
          },
        );
        const detail = withProvenance(
          sidebar.detail,
          view,
          [
            organizationId !== undefined && 'organization',
            ...sidebarFilters(sidebar),
            ...collections.flatMap((collection) => collection.filters ?? []),
            isPartialPage(rows.length, binding.pageSize) && 'page',
          ],
          [
            ...collections,
            ...rows.map((row) =>
              worktreeResource(row.workspaceId, row.worktree.id),
            ),
          ],
        );
        capture?.captureSidebar(sidebar.file, detail);
        const revisions = publishableRevisions(detail?.provenance);
        return firstPage(binding, {
          operation: 'core.worktree.list',
          items: rows.map((row) =>
            withRevision(
              projectWorktree(row.workspaceId, row.worktree),
              revisions.get(
                coreWorkspaceResourceKey(
                  worktreeResource(row.workspaceId, row.worktree.id).resource,
                ),
              ),
            ),
          ),
          legacy: { kind: 'sidebar', result: sidebar.file, detail },
        });
      });
    },
    'core.worktree.get': async (
      params: CanopyQueryParams<'core.worktree.get'>,
    ): Promise<CanopyQueryResult<'core.worktree.get'>> => {
      checkScope(params.scope);
      checkWorktreeScope(params.scope);
      if (
        params.scope?.worktreeId !== undefined &&
        params.scope.worktreeId !== params.worktreeId
      )
        throw worktreeNotFound();
      const workspaceId = params.scope?.workspaceId;
      const organizationId = params.scope?.organizationId;
      if (workspaceId) {
        checkWorktreeWorkspaceIdSpelling(workspaceId);
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
            const projection = worktreeResource(workspaceId, worktree.id);
            const readDetail = withProvenance(detail, view, [], [projection]);
            capture?.captureWorktree(worktree, readDetail);
            return withRevision(
              projectWorktree(workspaceId, worktree),
              publishableRevisions(readDetail?.provenance).get(
                coreWorkspaceResourceKey(projection.resource),
              ),
            );
          },
        );
      }
      return withReadView(services, DISCOVER_WORKSPACES, async (view) => {
        const sidebar = await readSidebar(services);
        let match: { workspaceId: string; worktree: WorktreeData } | undefined;
        for (const item of sidebar.file.items) {
          if (
            item.type === 'cowork' ||
            (organizationId !== undefined &&
              item.owner?.organizationId !== organizationId)
          )
            continue;
          const worktree = item.worktrees.find(
            (entry) => entry.id === params.worktreeId,
          );
          if (worktree) {
            if (match)
              throw new CanopyOperationError({
                kind: 'invalid_argument',
                message: 'Workspace scope required for ambiguous worktree ID.',
                retry: { kind: 'never' },
              });
            match = { workspaceId: item.id, worktree };
          }
        }
        if (!match) throw worktreeNotFound();
        const projection = worktreeResource(
          match.workspaceId,
          match.worktree.id,
        );
        const detail = withProvenance(sidebar.detail, view, [], [projection]);
        capture?.captureWorktree(match.worktree, detail);
        return withRevision(
          projectWorktree(match.workspaceId, match.worktree),
          publishableRevisions(detail?.provenance).get(
            coreWorkspaceResourceKey(projection.resource),
          ),
        );
      });
    },
  };
}
