import { isDeepStrictEqual } from 'node:util';
import {
  CORE_WORKSPACE_ACTIVITY_SECTION_IDS,
  CoreWorkspaceSchema,
  hasHostAbsolutePath,
  type CanopyCallerDescriptor,
  type CanopyWorkspaceScope,
  type CoreWorkspace,
  type CoreWorktree,
} from '@canopy/protocol/canopy-core';
import { PROJECT_COLORS } from '@canopy/protocol/project-colors';
import { isProjectStartPage } from '@canopy/protocol/start-page';
import { CanopyOperationError } from '../../runtime/errors';
import type { W5Resource } from '../w5/commit-log';
import type {
  StoredWorkspaceIndexFields,
  WorkspaceIndexAuthority,
} from '../w5/workspace-index-repository';
import type {
  CoreReadSnapshotBinding,
  CoreReadSnapshotOperation,
} from './core-workspace-read-snapshots';

/*
 * The host-neutral projection behind `core.workspace.*` and `core.worktree.*`
 * list/get (CAN-7239): scope checks, typed fields, repository sources, the
 * worktree row, provenance filters and paging, over the read port below.
 * Electron main's adapter (`core-workspace-adapter.ts`) composes the `select*`
 * stages over its own reads (CAN-7732), so its legacy capture lands before
 * any row projects; the equivalence golden pins the W5 read port to it.
 * Revisions come from the caller's capture, keyed by
 * `coreWorkspaceResourceKey`.
 */

/** Only `ok` and `absent` prove content complete. */
export type CoreWorkspaceReadAuthority = WorkspaceIndexAuthority;

/** Why a projection is not the whole W5 resource or collection it reads. */
export type CoreWorkspaceReadFilter =
  | 'workspace-scope'
  | 'worktree-scope'
  | 'organization'
  /** RR1: rows this process removed are left out without a write. */
  | 'recently-removed'
  /** Entries or rows the file format could not read were left out. */
  | 'unreadable-entries'
  /** Indexed workspaces the read could not project were left out. */
  | 'unprojected'
  /** Projected from a default after an unreadable read. */
  | 'fallback'
  | 'possibly-stale'
  | 'page';

/** Projected fields derived from the source, account or host (decision B1). */
export type CoreWorkspaceExternalField = 'repositorySources';

export type CoreWorkspaceFilters = readonly (
  | CoreWorkspaceReadFilter
  | false
  | undefined
)[];

export interface CoreWorkspaceResourceProjection {
  resource: W5Resource;
  filters?: CoreWorkspaceFilters;
  external?: readonly CoreWorkspaceExternalField[];
}

export const CORE_WORKSPACE_DEFAULT_PAGE_SIZE = 100;

// --- Errors -----------------------------------------------------------------

export function invalidArgument(message: string): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'invalid_argument',
    message,
    retry: { kind: 'never' },
  });
}

function unavailableScope(message: string): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'capability_unavailable',
    message,
    retry: { kind: 'never' },
  });
}

export function workspaceNotFound(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'not_found',
    message: 'Workspace not found.',
    retry: { kind: 'never' },
  });
}

export function worktreeNotFound(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'not_found',
    message: 'Worktree not found.',
    retry: { kind: 'never' },
  });
}

export function differentListing(): CanopyOperationError {
  return invalidArgument(
    'This list cursor belongs to a different listing. Repeat the scope and page size it was issued for.',
  );
}

function ambiguousWorktree(): CanopyOperationError {
  return invalidArgument('Workspace scope required for ambiguous worktree ID.');
}

/** A failed storage read cannot prove that a workspace is gone. */
export function workspaceStorageUnavailable(
  cause?: unknown,
): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind: 'unavailable',
      message:
        'Workspace storage is temporarily unavailable. Try again in a moment.',
      retry: { kind: 'same_request' },
    },
    cause,
  );
}

// --- Scope and id checks ------------------------------------------------------

/** Refuses another authority or any execution target; `authorityId` is the host's. */
export function checkCoreWorkspaceAuthority(
  scope: CanopyWorkspaceScope | undefined,
  authorityId: string,
): void {
  if (
    scope?.targetId !== undefined ||
    (scope?.authorityId !== undefined && scope.authorityId !== authorityId)
  )
    throw unavailableScope(
      'The selected workspace authority or target is unavailable.',
    );
}

export function checkCoreWorkspaceScope(scope?: CanopyWorkspaceScope): void {
  if (
    scope?.worktreeId !== undefined ||
    scope?.chatId !== undefined ||
    scope?.operationId !== undefined ||
    scope?.executionId !== undefined ||
    scope?.repoId !== undefined
  )
    throw unavailableScope('The selected workspace scope is unavailable.');
}

export function checkCoreWorkspaceIdSpelling(workspaceId?: string): void {
  if (workspaceId !== undefined && hasHostAbsolutePath(workspaceId))
    throw invalidArgument('Workspace ids cannot be host paths.');
}

export function checkCoreWorktreeScope(scope?: CanopyWorkspaceScope): void {
  if (
    scope?.chatId !== undefined ||
    scope?.operationId !== undefined ||
    scope?.executionId !== undefined ||
    scope?.repoId !== undefined
  )
    throw unavailableScope('The selected worktree scope is unavailable.');
}

/** Refuses traversal spellings before any capture or read. */
export function checkCoreWorktreeWorkspaceIdSpelling(
  workspaceId: string,
): void {
  if (
    workspaceId === '.' ||
    workspaceId === '..' ||
    workspaceId.includes('/') ||
    workspaceId.includes('\\')
  )
    throw worktreeNotFound();
}

/*
 * Each query's checks, in the order its handler makes them: before a cursor
 * is resumed or anything is read. A host that serves a cloud settings
 * revision on `core.workspace.get` refuses it first.
 */

export function checkCoreWorkspaceListParams(
  params: { scope?: CanopyWorkspaceScope },
  authorityId: string,
): void {
  checkCoreWorkspaceAuthority(params.scope, authorityId);
  checkCoreWorkspaceScope(params.scope);
  checkCoreWorkspaceIdSpelling(params.scope?.workspaceId);
}

export function checkCoreWorkspaceGetParams(
  params: { workspaceId: string; scope?: CanopyWorkspaceScope },
  authorityId: string,
): void {
  checkCoreWorkspaceAuthority(params.scope, authorityId);
  checkCoreWorkspaceScope(params.scope);
  checkCoreWorkspaceIdSpelling(params.workspaceId);
  checkCoreWorkspaceIdSpelling(params.scope?.workspaceId);
  if (
    params.scope?.workspaceId !== undefined &&
    params.scope.workspaceId !== params.workspaceId
  )
    throw workspaceNotFound();
}

export function checkCoreWorktreeListParams(
  params: { scope?: CanopyWorkspaceScope },
  authorityId: string,
): void {
  checkCoreWorkspaceAuthority(params.scope, authorityId);
  checkCoreWorktreeScope(params.scope);
  if (params.scope?.workspaceId)
    checkCoreWorktreeWorkspaceIdSpelling(params.scope.workspaceId);
}

export function checkCoreWorktreeGetParams(
  params: { worktreeId: string; scope?: CanopyWorkspaceScope },
  authorityId: string,
): void {
  checkCoreWorkspaceAuthority(params.scope, authorityId);
  checkCoreWorktreeScope(params.scope);
  if (
    params.scope?.worktreeId !== undefined &&
    params.scope.worktreeId !== params.worktreeId
  )
    throw worktreeNotFound();
  if (params.scope?.workspaceId)
    checkCoreWorktreeWorkspaceIdSpelling(params.scope.workspaceId);
}

// --- Index and manifest typed fields -----------------------------------------

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

export type CoreWorkspaceType = 'single-repo' | 'multi-repo' | 'cowork';

/** An index entry as its read normalizes it. */
export interface CoreWorkspaceIndexEntry {
  readonly id: string;
  readonly name: string;
  readonly type: CoreWorkspaceType;
  readonly color?: string;
  readonly collapsed?: boolean;
  readonly pinned?: boolean;
  readonly activitySectionOrder?: readonly string[];
}

/** The manifest's `core.workspace.update` fields as its read normalizes them. */
export interface CoreWorkspaceManifestFields {
  readonly itemSortMode?: string;
  readonly alwaysShow?: boolean;
  readonly startPage?: unknown;
}

/** The same fields as stored, before the read substitutes a default. */
export type StoredWorkspaceManifestFields = Readonly<
  Partial<Record<keyof CoreWorkspaceManifestFields, unknown>>
>;

const TYPED_FIELD_SCHEMAS = CoreWorkspaceSchema.shape;
const ACTIVITY_SECTION_IDS: readonly string[] =
  CORE_WORKSPACE_ACTIVITY_SECTION_IDS;

/** The index read's activity-section rule: an empty or invalid order is unset. */
export function normalizeCoreWorkspaceActivitySectionOrder(
  value: unknown,
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: readonly unknown[] = value;
  const normalized = entries.filter(
    (entry): entry is string =>
      typeof entry === 'string' && ACTIVITY_SECTION_IDS.includes(entry),
  );
  return normalized.length > 0 ? normalized : undefined;
}

interface FieldSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

/**
 * A stored value outside the patch schema is omitted, never coerced: one the
 * schema would rewrite (`z.url()` trims) would not be the stored edit baseline.
 */
function storedValue<T>(schema: FieldSchema<T>, value: unknown): T | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success && isDeepStrictEqual(parsed.data, value)
    ? parsed.data
    : undefined;
}

/**
 * The stored value when the read reports one (`null` included), so a
 * malformed value is omitted instead of read as the reader's default;
 * otherwise the read's own value, and `whenUnset` when the field is unset.
 */
function fieldSource(
  stored: unknown,
  read: unknown,
  whenUnset?: unknown,
): unknown {
  if (stored !== undefined) return stored;
  return read === undefined ? whenUnset : read;
}

/** Only palette colors: the update refuses any other (`Invalid project color`). */
function isProjectColor(color: string): boolean {
  return PROJECT_COLORS.some((candidate) => candidate === color);
}

/** Cowork has no activity section order. */
function indexTypedFields(
  index: CoreWorkspaceIndexEntry,
  stored: StoredWorkspaceIndexFields | undefined,
): CoreWorkspaceTypedFields {
  const fields: CoreWorkspaceTypedFields = {};
  const color = storedValue(
    TYPED_FIELD_SCHEMAS.color,
    fieldSource(stored?.color, index.color),
  );
  if (color !== undefined && isProjectColor(color)) fields.color = color;
  const pinned = storedValue(
    TYPED_FIELD_SCHEMAS.pinned,
    fieldSource(stored?.pinned, index.pinned, false),
  );
  if (pinned !== undefined) fields.pinned = pinned;
  const collapsed = storedValue(
    TYPED_FIELD_SCHEMAS.collapsed,
    fieldSource(stored?.collapsed, index.collapsed),
  );
  if (collapsed !== undefined) fields.collapsed = collapsed;
  if (index.type === 'cowork') return fields;
  // Repeated ids read as the rendered order, where the first one wins; an
  // unknown id is omitted with the order, since dropping it would edit it.
  const order = fieldSource(
    stored?.activitySectionOrder,
    index.activitySectionOrder,
    [],
  );
  const sections = storedValue(
    TYPED_FIELD_SCHEMAS.activitySectionOrder,
    Array.isArray(order) ? Array.from(new Set(order)) : order,
  );
  if (sections !== undefined) fields.activitySectionOrder = sections;
  return fields;
}

/** Cowork keeps its start page in its Cowork settings. */
function manifestTypedFields(
  type: CoreWorkspaceType,
  manifest: CoreWorkspaceManifestFields,
  stored: StoredWorkspaceManifestFields | undefined,
): CoreWorkspaceTypedFields {
  const fields: CoreWorkspaceTypedFields = {};
  const sortMode = storedValue(
    TYPED_FIELD_SCHEMAS.itemSortMode,
    fieldSource(stored?.itemSortMode, manifest.itemSortMode),
  );
  if (sortMode !== undefined) fields.itemSortMode = sortMode;
  // Unset only on a temporary combination: shown, but retired when empty.
  const alwaysShow = storedValue(
    TYPED_FIELD_SCHEMAS.alwaysShow,
    fieldSource(stored?.alwaysShow, manifest.alwaysShow),
  );
  if (alwaysShow !== undefined) fields.alwaysShow = alwaysShow;
  if (type === 'cowork') return fields;
  // A set start page also passes the update's own rule (`isProjectStartPage`).
  const page = fieldSource(stored?.startPage, manifest.startPage);
  const startPage =
    page === undefined
      ? { kind: 'inherit' as const }
      : page === null || isProjectStartPage(page)
        ? storedValue(TYPED_FIELD_SCHEMAS.startPage, page)
        : undefined;
  if (startPage !== undefined) fields.startPage = startPage;
  return fields;
}

/** A manifest read that proved its contents; others project no manifest field. */
export interface CoreWorkspaceProvenManifest {
  readonly fields: CoreWorkspaceManifestFields;
  readonly stored?: StoredWorkspaceManifestFields;
}

/**
 * The `core.workspace.update` patch fields as stored, so each is a valid edit
 * baseline: the index entry's always, the manifest's only from a read that
 * proved its contents (an absent or unreadable manifest reads as defaults).
 * A field whose stored value the update would refuse is omitted.
 */
export function projectCoreWorkspaceTypedFields(
  index: CoreWorkspaceIndexEntry,
  indexStored: StoredWorkspaceIndexFields | undefined,
  manifest: CoreWorkspaceProvenManifest | undefined,
): CoreWorkspaceTypedFields {
  return {
    ...indexTypedFields(index, indexStored),
    ...(manifest
      ? manifestTypedFields(index.type, manifest.fields, manifest.stored)
      : {}),
  };
}

// --- Repository sources -------------------------------------------------------

const MAX_REPO_ID_LENGTH = 512;
const MAX_REMOTE_URL_LENGTH = 4096;

function isScpStyleRemote(value: string): boolean {
  return !value.includes('://') && /^[^:@/\s]+@[^:/\s]+:[^?#\s]+$/.test(value);
}

/** A remote without credentials, query or fragment; null for a local path. */
export function sanitizeRemoteUrl(
  remoteUrl: string | null | undefined,
): string | null {
  const trimmed = remoteUrl?.trim();
  if (!trimmed || /^(?:\/|~\/|[a-zA-Z]:|\\\\)/.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol === 'file:' || !url.hostname) return null;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return isScpStyleRemote(trimmed) && trimmed.split('@', 1)[0] === 'git'
      ? trimmed
      : null;
  }
}

export interface CoreWorkspaceRepositoryRead {
  readonly id: string;
  readonly manifestUrl?: string | null;
}

/** Remote sources only; a repository id over 512 characters is refused. */
export function projectRepositorySources(
  repos: readonly CoreWorkspaceRepositoryRead[],
): CoreWorkspace['repositorySources'] {
  // Legacy persistence accepts any id length; the legacy helpers fall back.
  if (repos.some((repo) => repo.id.length > MAX_REPO_ID_LENGTH))
    throw invalidArgument('Workspace repository id exceeds 512 characters.');
  return repos.flatMap((repo) => {
    const remoteUrl = sanitizeRemoteUrl(repo.manifestUrl);
    return remoteUrl &&
      remoteUrl.length <= MAX_REMOTE_URL_LENGTH &&
      !hasHostAbsolutePath(remoteUrl)
      ? [{ repoId: repo.id, remoteUrl }]
      : [];
  });
}

/** Repository sources a source overlay can contribute, outside W5. */
export function sourceOverlayFields(manifest: {
  readonly type?: string;
  readonly sourceRepoPath?: string;
}): CoreWorkspaceExternalField[] {
  return manifest.type !== 'single-repo' &&
    manifest.sourceRepoPath !== undefined
    ? ['repositorySources']
    : [];
}

// --- Workspaces and worktrees -------------------------------------------------

/** A worktree row the list read kept. */
export interface CoreWorktreeRow {
  readonly id: string;
  readonly branchName: string;
  readonly createdAt: string;
  readonly label?: string;
  /** Any persisted health observation marks the row `error`. */
  readonly healthIssue?: unknown;
  readonly setupPhase?: unknown;
  readonly trackedBaseBranch?: string | null;
}

/** The `core.worktree.get` projection of one row, before its revision. */
export function projectCoreWorktree(
  workspaceId: string,
  row: CoreWorktreeRow,
): CoreWorktree {
  return {
    worktreeId: row.id,
    workspaceId,
    name: row.label || row.branchName,
    state: row.healthIssue
      ? 'error'
      : row.setupPhase === 'git-pending'
        ? 'creating'
        : 'ready',
    baseBranch: row.trackedBaseBranch ?? null,
    branch: row.branchName,
    createdAt: row.createdAt,
  };
}

/** The `core.workspace.get` fields every read projects, before its revision. */
export function projectCoreWorkspace(input: {
  index: CoreWorkspaceIndexEntry;
  indexStored?: StoredWorkspaceIndexFields;
  repositories: readonly CoreWorkspaceRepositoryRead[];
  manifest?: CoreWorkspaceProvenManifest;
}): CoreWorkspace {
  const { index } = input;
  return {
    workspaceId: index.id,
    name: index.name,
    kind: index.type === 'cowork' ? 'cowork' : 'git',
    repositorySources: projectRepositorySources(input.repositories),
    settings: {},
    ...projectCoreWorkspaceTypedFields(
      index,
      input.indexStored,
      input.manifest,
    ),
  };
}

export function withRevision<T extends object>(item: T, revision?: number): T {
  return revision === undefined ? item : { ...item, revision };
}

/** Follows `w5ResourceKey` without importing the commit log at runtime. */
export function coreWorkspaceResourceKey(resource: W5Resource): string {
  switch (resource.kind) {
    case 'workspaces':
      return 'workspaces';
    case 'workspace':
      return `workspace:${resource.workspaceId}`;
    case 'worktrees':
      return `worktrees:${resource.workspaceId}`;
    case 'worktree':
      return `worktree:${resource.workspaceId}/${resource.worktreeId}`;
  }
}

// --- Filters ------------------------------------------------------------------

/** A manifest read that could not prove its contents projects a default. */
export function manifestFilters(
  authority: CoreWorkspaceReadAuthority | undefined,
): CoreWorkspaceFilters {
  return [authority !== 'ok' && authority !== 'absent' && 'fallback'];
}

export function listFilters(
  authority: CoreWorkspaceReadAuthority | undefined,
  recentlyRemoved: boolean,
): CoreWorkspaceFilters {
  return [
    recentlyRemoved && 'recently-removed',
    authority === 'partial' && 'unreadable-entries',
    (authority === undefined || authority === 'unreadable') && 'fallback',
  ];
}

/** Index-level omissions; each workspace's own reads stay with its resources. */
export function sidebarFilters(
  sidebar: Pick<
    CoreWorkspaceSidebarRead,
    'indexAuthority' | 'indexedWorkspaceIds' | 'unprojected' | 'workspaces'
  >,
): CoreWorkspaceFilters {
  const index = sidebar.indexAuthority;
  return [
    (sidebar.indexedWorkspaceIds === undefined ||
      sidebar.workspaces.length < sidebar.indexedWorkspaceIds.length ||
      sidebar.unprojected === true) &&
      'unprojected',
    index === 'partial' && 'unreadable-entries',
    (index === undefined || index === 'unreadable') && 'fallback',
  ];
}

/**
 * Whether a first page leaves out part of `total` items. Paging a pinned
 * snapshot filters nothing from its collection, so only the result says so.
 */
export function isPartialPage(total: number, pageSize: number): boolean {
  return total > pageSize;
}

// --- Paging -------------------------------------------------------------------

// A type literal, so it takes the result schema's catchall index signature.
export type CoreWorkspaceListPage<Item> = {
  items: Item[];
  nextCursor: string | null;
  collectionRevision?: number;
};

export function listPage<Item>(
  pinned: { readonly items: Item[]; readonly collectionRevision?: number },
  offset: number,
  pageSize: number,
  nextCursor: string | null,
): CoreWorkspaceListPage<Item> {
  return {
    items: pinned.items.slice(offset, offset + pageSize),
    nextCursor,
    // Every page of a listing carries the first page's collection revision.
    ...(pinned.collectionRevision === undefined
      ? {}
      : { collectionRevision: pinned.collectionRevision }),
  };
}

export function listBinding(
  operation: CoreReadSnapshotOperation,
  params: { scope?: CanopyWorkspaceScope; pageSize?: number },
  caller?: CanopyCallerDescriptor,
): CoreReadSnapshotBinding {
  return {
    operation,
    scope: {
      workspaceId: params.scope?.workspaceId,
      organizationId: params.scope?.organizationId,
      worktreeId: params.scope?.worktreeId,
    },
    pageSize: params.pageSize ?? CORE_WORKSPACE_DEFAULT_PAGE_SIZE,
    ...(caller ? { caller } : {}),
  };
}

// --- The read port ------------------------------------------------------------

/** One workspace as the discovery read projected it. */
export interface CoreWorkspaceSidebarWorkspace<
  Row extends CoreWorktreeRow = CoreWorktreeRow,
> {
  readonly index: CoreWorkspaceIndexEntry;
  readonly indexStored?: StoredWorkspaceIndexFields;
  /** Absent when the read reports no manifest authority. */
  readonly manifestAuthority?: CoreWorkspaceReadAuthority;
  readonly manifest?: CoreWorkspaceProvenManifest;
  readonly organizationId?: string;
  /** The repositories the read resolved; a listing projects a multi-repo's only. */
  readonly repositories: readonly CoreWorkspaceRepositoryRead[];
  /** The source the read's repositories were overlaid from, when any. */
  readonly sourceRepoPath?: string;
  /** Code workspaces only. */
  readonly worktrees?: CoreWorktreeListRead<Row>;
}

/** The index and every workspace it names, from one read. */
export interface CoreWorkspaceSidebarRead<
  Row extends CoreWorktreeRow = CoreWorktreeRow,
> {
  /** The index read's own authority; absent when the read reports none. */
  readonly indexAuthority?: CoreWorkspaceReadAuthority;
  /** Every indexed id, including unprojected ones; absent when unreported. */
  readonly indexedWorkspaceIds?: readonly string[];
  /** Set when the host left out workspaces for reasons only it decides. */
  readonly unprojected?: boolean;
  /** In display order. */
  readonly workspaces: readonly CoreWorkspaceSidebarWorkspace<Row>[];
}

export interface CoreWorkspaceIndexRead {
  readonly entry: CoreWorkspaceIndexEntry;
  readonly stored?: StoredWorkspaceIndexFields;
}

/** One workspace's manifest read. */
export interface CoreWorkspaceManifestRead {
  /** Absent when the read reports none: the manifest projects as read. */
  readonly authority?: CoreWorkspaceReadAuthority;
  readonly type: CoreWorkspaceType;
  readonly sourceRepoPath?: string;
  /** The repositories `core.workspace.get` projects sources from. */
  readonly repositories: readonly CoreWorkspaceRepositoryRead[];
  readonly organizationId?: string;
  readonly fields: CoreWorkspaceManifestFields;
  /** Only from a read with authority `ok`. */
  readonly stored?: StoredWorkspaceManifestFields;
}

export interface CoreWorktreeListRead<
  Row extends CoreWorktreeRow = CoreWorktreeRow,
> {
  readonly rows: readonly Row[];
  /** Absent when the read reports none. */
  readonly authority?: CoreWorkspaceReadAuthority;
  /** RR1: the read left out rows this process removed. */
  readonly recentlyRemoved: boolean;
}

/** What the projection reads; every call of one query sees one capture. */
export interface CoreWorkspaceProjectionReads {
  readSidebar(): Promise<CoreWorkspaceSidebarRead>;
  /** Null when the index has no such workspace; throws when it cannot tell. */
  readIndexEntry(workspaceId: string): Promise<CoreWorkspaceIndexRead | null>;
  readManifest(workspaceId: string): Promise<CoreWorkspaceManifestRead>;
  readWorktrees(workspaceId: string): Promise<CoreWorktreeListRead>;
}

// --- Query projections --------------------------------------------------------

/** A projected result before its revisions, with what its provenance needs. */
export interface CoreWorkspaceProjected<Result> {
  readonly result: Result;
  readonly filters: CoreWorkspaceFilters;
  readonly resources: readonly CoreWorkspaceResourceProjection[];
}

export interface CoreWorkspaceProjectedRow<Item> {
  readonly item: Item;
  readonly resource: W5Resource;
}

export interface CoreWorkspaceProjectedList<Item> {
  readonly rows: readonly CoreWorkspaceProjectedRow<Item>[];
  /** Absent for a listing no single collection spans. */
  readonly collection?: W5Resource;
}

/**
 * A query's selection over reads already made: what its provenance needs,
 * and its result only on demand, so a host can publish what it read first.
 */
export interface CoreWorkspaceSelection<Result> {
  readonly filters: CoreWorkspaceFilters;
  readonly resources: readonly CoreWorkspaceResourceProjection[];
  project(): Result;
}

export interface CoreWorkspaceListSelection<
  Item,
> extends CoreWorkspaceSelection<CoreWorkspaceProjectedList<Item>> {
  /** The rows the listing holds, counted before any projects. */
  readonly total: number;
}

function projectSelection<Result>(
  selection: CoreWorkspaceSelection<Result>,
): CoreWorkspaceProjected<Result> {
  return {
    filters: selection.filters,
    resources: selection.resources,
    result: selection.project(),
  };
}

/** Publishable revisions by `coreWorkspaceResourceKey`. */
export type CoreWorkspaceRevisions = ReadonlyMap<string, number>;

export function publishCoreWorkspaceList<Item extends object>(
  list: CoreWorkspaceProjectedList<Item>,
  revisions: CoreWorkspaceRevisions,
): { items: Item[]; collectionRevision?: number } {
  const collectionRevision =
    list.collection && revisions.get(coreWorkspaceResourceKey(list.collection));
  return {
    items: list.rows.map(({ item, resource }) =>
      withRevision(item, revisions.get(coreWorkspaceResourceKey(resource))),
    ),
    ...(collectionRevision === undefined ? {} : { collectionRevision }),
  };
}

export function publishCoreWorkspaceItem<Item extends object>(
  row: CoreWorkspaceProjectedRow<Item>,
  revisions: CoreWorkspaceRevisions,
): Item {
  return withRevision(
    row.item,
    revisions.get(coreWorkspaceResourceKey(row.resource)),
  );
}

function worktreeResource(
  workspaceId: string,
  worktreeId: string,
): CoreWorkspaceResourceProjection {
  return { resource: { kind: 'worktree', workspaceId, worktreeId } };
}

/** A listing's workspace: only a multi-repo projects repositories. */
function listedWorkspace(
  workspace: CoreWorkspaceSidebarWorkspace,
): CoreWorkspace {
  return projectCoreWorkspace({
    index: workspace.index,
    indexStored: workspace.indexStored,
    repositories:
      workspace.index.type === 'multi-repo' ? workspace.repositories : [],
    manifest: workspace.manifest,
  });
}

/** `core.workspace.list`'s first page selection, after its scope checks. */
export function selectCoreWorkspaceList(
  sidebar: CoreWorkspaceSidebarRead,
  scope: CanopyWorkspaceScope | undefined,
  pageSize: number,
): CoreWorkspaceListSelection<CoreWorkspace> {
  // Kept in order, not by id: duplicate-id rows keep their own fields.
  const workspaces = sidebar.workspaces.filter(
    ({ index, organizationId }) =>
      (scope?.workspaceId === undefined || index.id === scope.workspaceId) &&
      (scope?.organizationId === undefined ||
        organizationId === scope.organizationId),
  );
  const filters: CoreWorkspaceFilters = [
    scope?.workspaceId !== undefined && 'workspace-scope',
    scope?.organizationId !== undefined && 'organization',
    ...sidebarFilters(sidebar),
  ];
  const collection: W5Resource = { kind: 'workspaces' };
  return {
    total: workspaces.length,
    filters: [...filters, isPartialPage(workspaces.length, pageSize) && 'page'],
    resources: [
      { resource: collection, filters },
      ...workspaces.map(
        (workspace): CoreWorkspaceResourceProjection => ({
          resource: { kind: 'workspace', workspaceId: workspace.index.id },
          filters: manifestFilters(workspace.manifestAuthority),
          external:
            workspace.index.type === 'multi-repo'
              ? sourceOverlayFields({
                  type: workspace.index.type,
                  sourceRepoPath: workspace.sourceRepoPath,
                })
              : [],
        }),
      ),
    ],
    project: () => ({
      collection,
      rows: workspaces.map((workspace) => ({
        item: listedWorkspace(workspace),
        resource: { kind: 'workspace', workspaceId: workspace.index.id },
      })),
    }),
  };
}

/** `core.workspace.list`'s first page projection, after its scope checks. */
export async function projectCoreWorkspaceList(
  reads: Pick<CoreWorkspaceProjectionReads, 'readSidebar'>,
  scope: CanopyWorkspaceScope | undefined,
  pageSize: number,
): Promise<CoreWorkspaceProjected<CoreWorkspaceProjectedList<CoreWorkspace>>> {
  return projectSelection(
    selectCoreWorkspaceList(await reads.readSidebar(), scope, pageSize),
  );
}

/** `core.workspace.get`'s resources, from its manifest read alone. */
export function coreWorkspaceGetResources(
  workspaceId: string,
  manifest: {
    readonly authority?: CoreWorkspaceReadAuthority;
    readonly type?: string;
    readonly sourceRepoPath?: string;
  },
): CoreWorkspaceResourceProjection[] {
  return [
    {
      resource: { kind: 'workspace', workspaceId },
      filters: manifestFilters(manifest.authority),
      external: sourceOverlayFields(manifest),
    },
  ];
}

/** An organization scope sees only its own workspaces; others are not found. */
export function checkCoreWorkspaceOrganization(
  scope: CanopyWorkspaceScope | undefined,
  organizationId: string | undefined,
): void {
  if (
    scope?.organizationId !== undefined &&
    organizationId !== scope.organizationId
  )
    throw workspaceNotFound();
}

/**
 * `core.workspace.get`'s row from its index and manifest reads. A read that
 * reports no authority projects its manifest as read.
 */
export function projectCoreWorkspaceGetRow(
  indexRead: CoreWorkspaceIndexRead,
  manifest: Pick<
    CoreWorkspaceManifestRead,
    'authority' | 'repositories' | 'fields' | 'stored'
  >,
): CoreWorkspaceProjectedRow<CoreWorkspace> {
  const proven =
    manifest.authority === undefined || manifest.authority === 'ok';
  return {
    resource: { kind: 'workspace', workspaceId: indexRead.entry.id },
    item: projectCoreWorkspace({
      index: indexRead.entry,
      indexStored: indexRead.stored,
      repositories: manifest.repositories,
      ...(proven
        ? { manifest: { fields: manifest.fields, stored: manifest.stored } }
        : {}),
    }),
  };
}

/** `core.workspace.get`'s projection, after its scope checks. */
export async function projectCoreWorkspaceGet(
  reads: Pick<CoreWorkspaceProjectionReads, 'readIndexEntry' | 'readManifest'>,
  workspaceId: string,
  scope: CanopyWorkspaceScope | undefined,
): Promise<CoreWorkspaceProjected<CoreWorkspaceProjectedRow<CoreWorkspace>>> {
  // The index lookup stays first: it keeps unknown ids off the manifest path.
  const indexRead = await reads.readIndexEntry(workspaceId);
  if (!indexRead) throw workspaceNotFound();
  const manifest = await reads.readManifest(workspaceId);
  checkCoreWorkspaceOrganization(scope, manifest.organizationId);
  return {
    filters: [],
    resources: coreWorkspaceGetResources(workspaceId, manifest),
    result: projectCoreWorkspaceGetRow(indexRead, manifest),
  };
}

async function checkWorktreeWorkspace(
  reads: Pick<CoreWorkspaceProjectionReads, 'readIndexEntry'>,
  workspaceId: string,
): Promise<void> {
  if (!(await reads.readIndexEntry(workspaceId))) throw worktreeNotFound();
}

function isListedForWorktrees(
  workspace: CoreWorkspaceSidebarWorkspace<CoreWorktreeRow>,
  organizationId: string | undefined,
): boolean {
  return (
    workspace.index.type !== 'cowork' &&
    (organizationId === undefined ||
      workspace.organizationId === organizationId)
  );
}

/**
 * `core.worktree.list`'s first page selection over one workspace's list,
 * after its scope checks and index lookup. `ownerOrganizationId` is the
 * manifest's, read only for an organization scope.
 */
export function selectCoreWorkspaceWorktreeList(
  workspaceId: string,
  list: CoreWorktreeListRead,
  ownerOrganizationId: string | undefined,
  scope: CanopyWorkspaceScope | undefined,
  pageSize: number,
): CoreWorkspaceListSelection<CoreWorktree> {
  const organizationId = scope?.organizationId;
  const worktreeId = scope?.worktreeId;
  const rows = list.rows.filter(
    (row) =>
      (worktreeId === undefined || row.id === worktreeId) &&
      (organizationId === undefined || ownerOrganizationId === organizationId),
  );
  const filters: CoreWorkspaceFilters = [
    worktreeId !== undefined && 'worktree-scope',
    organizationId !== undefined && 'organization',
    ...listFilters(list.authority, list.recentlyRemoved),
  ];
  const collection: W5Resource = { kind: 'worktrees', workspaceId };
  return {
    total: rows.length,
    filters: [...filters, isPartialPage(rows.length, pageSize) && 'page'],
    resources: [
      { resource: collection, filters },
      ...rows.map((row) => worktreeResource(workspaceId, row.id)),
    ],
    project: () => ({
      collection,
      rows: rows.map((row) => ({
        item: projectCoreWorktree(workspaceId, row),
        resource: worktreeResource(workspaceId, row.id).resource,
      })),
    }),
  };
}

/** `core.worktree.list`'s unscoped first page selection over one discovery read. */
export function selectCoreWorktreeListAcrossWorkspaces(
  sidebar: CoreWorkspaceSidebarRead,
  scope: CanopyWorkspaceScope | undefined,
  pageSize: number,
): CoreWorkspaceListSelection<CoreWorktree> {
  const organizationId = scope?.organizationId;
  const worktreeId = scope?.worktreeId;
  const included = sidebar.workspaces.filter((workspace) =>
    isListedForWorktrees(workspace, organizationId),
  );
  const rows = included.flatMap((workspace) =>
    (workspace.worktrees?.rows ?? [])
      .filter((row) => worktreeId === undefined || row.id === worktreeId)
      .map((row) => ({ workspaceId: workspace.index.id, row })),
  );
  // Each workspace's list is its own resource; no collection spans them, so
  // this aggregation publishes no collection revision.
  const collections = included.map(
    (workspace): CoreWorkspaceResourceProjection => ({
      resource: { kind: 'worktrees', workspaceId: workspace.index.id },
      filters: [
        worktreeId !== undefined && 'worktree-scope',
        ...listFilters(
          workspace.worktrees?.authority,
          workspace.worktrees?.recentlyRemoved ?? false,
        ),
      ],
    }),
  );
  return {
    total: rows.length,
    filters: [
      organizationId !== undefined && 'organization',
      ...sidebarFilters(sidebar),
      ...collections.flatMap((collection) => collection.filters ?? []),
      isPartialPage(rows.length, pageSize) && 'page',
    ],
    resources: [
      ...collections,
      ...rows.map((entry) => worktreeResource(entry.workspaceId, entry.row.id)),
    ],
    project: () => ({
      rows: rows.map((entry) => ({
        item: projectCoreWorktree(entry.workspaceId, entry.row),
        resource: worktreeResource(entry.workspaceId, entry.row.id).resource,
      })),
    }),
  };
}

/** `core.worktree.list`'s first page projection, after its scope checks. */
export async function projectCoreWorktreeList(
  reads: CoreWorkspaceProjectionReads,
  scope: CanopyWorkspaceScope | undefined,
  pageSize: number,
): Promise<CoreWorkspaceProjected<CoreWorkspaceProjectedList<CoreWorktree>>> {
  const workspaceId = scope?.workspaceId;
  if (!workspaceId)
    return projectSelection(
      selectCoreWorktreeListAcrossWorkspaces(
        await reads.readSidebar(),
        scope,
        pageSize,
      ),
    );
  await checkWorktreeWorkspace(reads, workspaceId);
  const list = await reads.readWorktrees(workspaceId);
  const owner = scope.organizationId
    ? (await reads.readManifest(workspaceId)).organizationId
    : undefined;
  return projectSelection(
    selectCoreWorkspaceWorktreeList(workspaceId, list, owner, scope, pageSize),
  );
}

/**
 * The one row with `worktreeId` across a discovery read's code workspaces in
 * the organization scope, if any; refuses an id two of them hold.
 */
export function findCoreWorktreeAcrossWorkspaces<Row extends CoreWorktreeRow>(
  sidebar: CoreWorkspaceSidebarRead<Row>,
  worktreeId: string,
  organizationId: string | undefined,
): { workspaceId: string; row: Row } | undefined {
  let match: { workspaceId: string; row: Row } | undefined;
  for (const workspace of sidebar.workspaces) {
    if (!isListedForWorktrees(workspace, organizationId)) continue;
    const row = workspace.worktrees?.rows.find(
      (entry) => entry.id === worktreeId,
    );
    if (!row) continue;
    if (match) throw ambiguousWorktree();
    match = { workspaceId: workspace.index.id, row };
  }
  return match;
}

/** `core.worktree.get`'s selection of the row it found. */
export function selectCoreWorktreeGet(
  workspaceId: string,
  row: CoreWorktreeRow,
): CoreWorkspaceSelection<CoreWorkspaceProjectedRow<CoreWorktree>> {
  const projection = worktreeResource(workspaceId, row.id);
  return {
    filters: [],
    resources: [projection],
    project: () => ({
      resource: projection.resource,
      item: projectCoreWorktree(workspaceId, row),
    }),
  };
}

/** `core.worktree.get`'s projection, after its scope checks. */
export async function projectCoreWorktreeGet(
  reads: CoreWorkspaceProjectionReads,
  worktreeId: string,
  scope: CanopyWorkspaceScope | undefined,
): Promise<CoreWorkspaceProjected<CoreWorkspaceProjectedRow<CoreWorktree>>> {
  const workspaceId = scope?.workspaceId;
  const organizationId = scope?.organizationId;
  let match: { workspaceId: string; row: CoreWorktreeRow } | undefined;
  if (workspaceId) {
    await checkWorktreeWorkspace(reads, workspaceId);
    if (
      organizationId !== undefined &&
      (await reads.readManifest(workspaceId)).organizationId !== organizationId
    )
      throw worktreeNotFound();
    const row = (await reads.readWorktrees(workspaceId)).rows.find(
      (entry) => entry.id === worktreeId,
    );
    if (row) match = { workspaceId, row };
  } else {
    match = findCoreWorktreeAcrossWorkspaces(
      await reads.readSidebar(),
      worktreeId,
      organizationId,
    );
  }
  if (!match) throw worktreeNotFound();
  return projectSelection(selectCoreWorktreeGet(match.workspaceId, match.row));
}
