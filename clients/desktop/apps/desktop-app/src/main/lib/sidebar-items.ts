import { createW5RecordImageRepositories } from '@canopy/core-runtime/node/w5/record-image-repositories';
import {
  consumeW5Metadata,
  prepareW5Metadata,
  readPreparedW5Worktrees,
  type PreparedW5Metadata,
} from './w5-metadata-preparation';
import { isW5ProjectionOnlyView } from './w5-fallback-read';
import { afterW5Commit } from './w5-commit-scope';
import { isAbsolute } from 'node:path';
import {
  normalizeHookInputMap,
  type HookOverrides,
} from '@canopy/desktop-shared/hooks';
import {
  normalizeScriptInputMap,
  type ScriptOverrides,
} from '@canopy/desktop-shared/scripts';
import type {
  ActivitySectionId,
  CoworkSidebarItem,
  MultiRepoSidebarItem,
  SidebarItem,
  SidebarItemsFile,
  SidebarItemsLoadWarning,
  SidebarItemsSaveOptions,
  SingleRepoSidebarItem,
  WorkspaceConfigFile,
  WorkspaceIndexEntry,
  WorkspaceRepoData,
  WorkspaceType,
  WorktreeData,
  WorktreeEffectiveOverrides,
} from '@canopy/desktop-shared/types';
import { notifyPortalStructureChanged } from '../portal/portal-event-bus';
import { getObservabilityService } from '../observability';
import {
  PROJECT_W5_STORAGE,
  WORKSPACE_INDEX_STORAGE,
  withStorageAdmission,
} from './w5-storage';
import { validateId } from './validation';
import { desktopW5FileStore } from './w5-commit-log-file-store';
import type { W5NamedUnreadableError } from './w5-file-store';
import {
  normalizeActivitySectionOrder,
  type StoredWorkspaceIndexFields,
  type StoredWorkspaceIndexRepository,
  type WorkspaceIndexAuthority,
  type WorkspaceIndexRepository,
} from './workspace-index-repository';
import {
  getWorkspacesRootDir,
  getWorkspaceWorktreeDir,
  getWorkspaceWorktreeRepoDir,
} from './paths';
import { schedulePortalStructuralSync } from '../portal/portal-structural-sync';
import {
  readWorkspaceConfigDetailed,
  readWorkspaceWorktreesDetailed,
  updateWorkspaceConfig,
  WorkspaceConfigUnreadableError,
  WorktreeRegistryUnreadableError,
  writeWorkspaceWorktrees,
  type PersistedFileAuthority,
  type StoredWorkspaceManifestFields,
  type WorkspaceConfigOwnershipWrite,
} from './workspace-persistence';
import {
  getWorkspaceExternalPath,
  registerWorkspaceExternalPaths,
  registerWorkspaceTypes,
} from './workspace-registry';
import { normalizeLegacyScriptFields } from './script-config';
import {
  resolveProjectScripts,
  resolveWorkspaceRepoScripts,
  resolveWorkspaceRootScripts,
  toScriptOverrides,
} from './script-resolver';
import {
  resolveProjectHooks,
  resolveWorkspaceRepoDataHooks,
  resolveWorkspaceRepoHooks,
  resolveWorkspaceRootHooks,
  toHookOverrides,
} from './hook-resolver';
import { InvalidCanopyJsonError } from './canopy-json';
import { readEffectiveWorkspaceConfig } from './workspace-source';
import { countArchivedContainers } from './archived-containers';
import { readWorkEntrySidebarSummary } from './cowork-work-entries-file';
import { settleAll } from '@canopy/desktop-shared/node/lib/detached-work';
import { workspaceStorageUnavailable } from './workspace-storage-availability';

export {
  WorkspaceIndexUnreadableError,
  type WorkspaceIndexAuthority,
} from './workspace-index-repository';

let lastKnownSidebarItemIds: Set<string> | null = null;

function recordWorkspaceIndexWriteRefused(): void {
  try {
    getObservabilityService().recordAppDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'workspace_index_write_refused',
      reason: 'unreadable',
    });
  } catch {
    // Diagnostics are best effort; the refusal itself protects the index.
  }
}

function createDesktopWorkspaceIndexRepository(): StoredWorkspaceIndexRepository {
  const repository = createW5RecordImageRepositories({
    root: getWorkspacesRootDir,
    store: desktopW5FileStore,
  }).index({
    writer: WORKSPACE_INDEX_STORAGE.writer,
    normalizeActivitySectionOrder,
    // Every durable workspace-index mutation (create/update/reorder/section
    // order, desktop- or portal-initiated) commits through this repository,
    // so this keeps a connected portal session current (CAN-1304). Workspace
    // deletion never rewrites the index (it self-heals on read), so
    // `deleteWorkspaceById` schedules its own sync.
    onCommitted: schedulePortalStructuralSync,
    onRefused: recordWorkspaceIndexWriteRefused,
  });
  return {
    ...repository,
    update: (change) =>
      withStorageAdmission([WORKSPACE_INDEX_STORAGE], () =>
        repository.update(change),
      ),
  };
}

let workspaceIndexRepository = createDesktopWorkspaceIndexRepository();

/** The desktop's workspace index repository (CAN-3800). */
export function getWorkspaceIndexRepository(): WorkspaceIndexRepository {
  return workspaceIndexRepository;
}

export function __resetSidebarItemsStateForTests(): void {
  lastKnownSidebarItemIds = null;
  workspaceIndexRepository = createDesktopWorkspaceIndexRepository();
}

interface ReadSidebarItemResult {
  item: SidebarItem | null;
  warning?: SidebarItemsLoadWarning;
}

async function readArchivedContainerCount(
  workspaceId: string,
): Promise<number> {
  // Archive metadata is additive sidebar decoration. A transient filesystem
  // read failure must not make the workspace itself disappear from the
  // authoritative sidebar response; the next changed event/read retries it.
  // Only committed manifests contribute to this decoration. Waiting for the
  // workspace's archive-copy lock here also blocks every session snapshot
  // and unrelated project; commit notifications refresh the count later.
  return countArchivedContainers(workspaceId, { waitForMutation: false }).catch(
    () => 0,
  );
}

/**
 * A code workspace whose `workspace.json` could not be read is reported as a
 * load warning instead of an item built from the reader's default config
 * (no repositories, no settings). Every sidebar writer preserves warned
 * workspaces untouched, so a save can never persist that default over the
 * real file (CAN-3563).
 */
function assertWorkspaceConfigReadable(
  authority: PersistedFileAuthority,
): void {
  if (authority === 'unreadable') {
    throw new Error('its project settings could not be read');
  }
}

/** One workspace's manifest reads in a sidebar snapshot, kept apart from the aggregate. */
export interface SidebarWorkspaceReads {
  manifest?: WorkspaceIndexAuthority;
  worktrees?: WorkspaceIndexAuthority;
  recentlyRemovedWorktreeIds?: string[];
}

/** One workspace's stored `core.workspace.update` fields in a sidebar snapshot. */
export interface SidebarWorkspaceStoredFields {
  index?: StoredWorkspaceIndexFields;
  /** Only from a manifest read with authority `ok`. */
  manifest?: StoredWorkspaceManifestFields;
}

/**
 * Records the authority of every manifest read (`workspace.json`,
 * `worktrees.json`) made while projecting one sidebar snapshot.
 */
interface ManifestAuthorityCollector {
  readOptions?: { persistRemovalCleanup?: false };
  record(
    workspaceId: string,
    read:
      | {
          file: 'manifest';
          authority: WorkspaceIndexAuthority;
          storedFields?: StoredWorkspaceManifestFields;
          /** The read config's, whatever its authority. */
          externalPath: string | undefined;
        }
      | {
          file: 'worktrees';
          authority: WorkspaceIndexAuthority;
          recentlyRemovedWorktreeIds?: string[];
        },
  ): void;
}

function recordWorkspaceReads(
  collector: ManifestAuthorityCollector | undefined,
  workspaceId: string,
  configRead: {
    config: Pick<WorkspaceConfigFile, 'externalPath'>;
    authority: PersistedFileAuthority;
    storedFields?: StoredWorkspaceManifestFields;
  },
  worktreesRead: {
    authority: WorkspaceIndexAuthority;
    recentlyRemovedWorktreeIds?: string[];
  },
): void {
  collector?.record(workspaceId, {
    file: 'manifest',
    authority: configRead.authority,
    ...(configRead.storedFields
      ? { storedFields: configRead.storedFields }
      : {}),
    externalPath: configRead.config.externalPath,
  });
  collector?.record(workspaceId, {
    file: 'worktrees',
    authority: worktreesRead.authority,
    ...(worktreesRead.recentlyRemovedWorktreeIds
      ? { recentlyRemovedWorktreeIds: worktreesRead.recentlyRemovedWorktreeIds }
      : {}),
  });
}

const AUTHORITY_RANK: Record<WorkspaceIndexAuthority, number> = {
  ok: 0,
  absent: 0,
  partial: 1,
  unreadable: 2,
};

function weakerAuthority(
  left: WorkspaceIndexAuthority,
  right: WorkspaceIndexAuthority,
): WorkspaceIndexAuthority {
  return AUTHORITY_RANK[right] > AUTHORITY_RANK[left] ? right : left;
}

export function readWorkspaceIndexStoredDetailed(): ReturnType<
  typeof workspaceIndexRepository.readStored
> {
  return workspaceIndexRepository.readStored();
}

async function readWorkspaceIndex(): Promise<WorkspaceIndexEntry[]> {
  return (await workspaceIndexRepository.read()).entries;
}

/**
 * Read a single workspace's index entry (name + type + display metadata) by
 * id, without loading every workspace's full sidebar item. Returns null when
 * the workspace is absent. Used by the telemetry-sync service (CAN-402) to
 * label the workspace envelope.
 */
export async function readWorkspaceIndexEntry(
  workspaceId: string,
): Promise<WorkspaceIndexEntry | null> {
  const index = await readWorkspaceIndex();
  return index.find((entry) => entry.id === workspaceId) ?? null;
}

/** Stored fields for a core read; an unreadable index cannot prove absence. */
export async function readWorkspaceIndexEntryDetailed(
  workspaceId: string,
): Promise<{
  entry: WorkspaceIndexEntry;
  storedFields: StoredWorkspaceIndexFields;
} | null> {
  const { entries, storedFields, authority, unserved } =
    await workspaceIndexRepository.readStored();
  if (authority === 'unreadable') throw workspaceStorageUnavailable(unserved);
  // The first entry with the id, as in readWorkspaceIndexEntry.
  const position = entries.findIndex(
    (candidate) => candidate.id === workspaceId,
  );
  const entry = entries[position];
  const fields = storedFields[position];
  return entry && fields ? { entry, storedFields: fields } : null;
}

function toWorkspaceIndexEntry(item: SidebarItem): WorkspaceIndexEntry {
  const entry: WorkspaceIndexEntry = {
    id: item.id,
    name: item.name,
    type: item.type,
    color: item.color,
    collapsed: item.collapsed,
    order: item.order,
    ...(item.pinned === true ? { pinned: true } : {}),
  };

  if (item.type !== 'cowork' && item.activitySectionOrder) {
    entry.activitySectionOrder = item.activitySectionOrder;
  }

  return entry;
}

async function writeWorkspaceIndex(
  items: SidebarItem[],
  replaceWorkspaceOrder: boolean,
  preserveWorkspaceIds: ReadonlySet<string> = new Set(),
  preserveUnmentionedWorkspaceIds: boolean = false,
  deletedWorkspaceIds: ReadonlySet<string> = new Set(),
): Promise<WorkspaceIndexEntry[]> {
  return workspaceIndexRepository.update(({ entries: current, authority }) => {
    // The merge below drops every entry it did not read, so rewriting over an
    // unreadable index would erase the whole sidebar (CAN-3329); the
    // repository refuses that write.
    if (authority === 'unreadable') {
      return { result: [], entries: [] };
    }
    const incomingItemIds = new Set(items.map((item) => item.id));
    const effectivePreserveWorkspaceIds = new Set(preserveWorkspaceIds);
    if (preserveUnmentionedWorkspaceIds) {
      current.forEach((entry) => {
        if (
          !incomingItemIds.has(entry.id) &&
          !deletedWorkspaceIds.has(entry.id)
        ) {
          effectivePreserveWorkspaceIds.add(entry.id);
        }
      });
    }
    const currentById = new Map(current.map((entry) => [entry.id, entry]));
    const incoming = items.flatMap((item) => {
      if (!effectivePreserveWorkspaceIds.has(item.id)) {
        return [toWorkspaceIndexEntry(item)];
      }
      const persisted = currentById.get(item.id);
      if (!persisted) throw new WorkspaceConfigUnreadableError();
      return [
        replaceWorkspaceOrder ? { ...persisted, order: item.order } : persisted,
      ];
    });
    if (replaceWorkspaceOrder) {
      const incomingQueue = [...incoming];
      const incomingIds = new Set(incoming.map((entry) => entry.id));
      const reordered = current.flatMap((entry) => {
        if (
          effectivePreserveWorkspaceIds.has(entry.id) &&
          !incomingIds.has(entry.id)
        ) {
          return [entry];
        }
        const replacement = incomingQueue.shift();
        return replacement ? [replacement] : [];
      });
      reordered.push(...incomingQueue);
      const normalized = reordered.map((entry, order) => ({
        ...entry,
        order,
      }));
      return { result: normalized, entries: normalized };
    }

    const incomingById = new Map(incoming.map((entry) => [entry.id, entry]));
    const merged = current.flatMap((entry) => {
      const replacement = incomingById.get(entry.id);
      if (!replacement) {
        return effectivePreserveWorkspaceIds.has(entry.id) ? [entry] : [];
      }
      incomingById.delete(entry.id);
      return [replacement];
    });
    merged.push(...incoming.filter((entry) => incomingById.has(entry.id)));
    const normalized = merged.map((entry, order) => ({ ...entry, order }));
    return { result: normalized, entries: normalized };
  });
}

function toSingleRepoWorkspaceConfig(
  item: SingleRepoSidebarItem,
): WorkspaceConfigFile {
  return {
    version: 1,
    type: 'single-repo',
    repoPath: item.repoPath,
    repos: [],
    sourceRepoPath: undefined,
    suppressedRepoIds: undefined,
    temporary: undefined,
    externalPath: item.externalPath,
    defaultPluginSelections: item.defaultPluginSelections,
    disabledGlobalPluginSelections: item.disabledGlobalPluginSelections,
    scripts: normalizeScriptInputMap(item.scripts),
    hooks: normalizeHookInputMap(item.hooks),
    alwaysShow: item.alwaysShow,
    owner: item.owner,
    itemSortMode: item.itemSortMode,
    archiveRetentionDays: item.archiveRetentionDays,
    autoArchiveDays: item.autoArchiveDays,
    autoArchiveDeleteBranch: item.autoArchiveDeleteBranch,
    startPage: item.startPage,
  };
}

function normalizeWorkspaceRepoScripts(
  repos: WorkspaceRepoData[],
): WorkspaceRepoData[] {
  return repos.map((repo) => ({
    id: repo.id,
    name: repo.name,
    repoPath: repo.repoPath,
    source: repo.source,
    manifestUrl: repo.manifestUrl,
    scripts: normalizeScriptInputMap(repo.scripts),
    hooks: normalizeHookInputMap(repo.hooks),
  }));
}

function toMultiRepoWorkspaceConfig(
  item: MultiRepoSidebarItem,
): WorkspaceConfigFile {
  return {
    version: 1,
    type: 'multi-repo',
    repoPath: undefined,
    repos: normalizeWorkspaceRepoScripts(item.repos),
    externalPath: item.externalPath,
    defaultPluginSelections: item.defaultPluginSelections,
    disabledGlobalPluginSelections: item.disabledGlobalPluginSelections,
    sourceRepoPath: item.sourceRepoPath,
    scripts: normalizeScriptInputMap(item.scripts),
    hooks: normalizeHookInputMap(item.hooks),
    suppressedRepoIds: item.suppressedRepoIds,
    alwaysShow: item.alwaysShow,
    owner: item.owner,
    itemSortMode: item.itemSortMode,
    temporary: item.temporary === true ? true : undefined,
    archiveRetentionDays: item.archiveRetentionDays,
    autoArchiveDays: item.autoArchiveDays,
    autoArchiveDeleteBranch: item.autoArchiveDeleteBranch,
    startPage: item.startPage,
    temporarySourceWorkspaceIds: item.temporarySourceWorkspaceIds,
    temporaryRepoIdentityKeys: item.temporaryRepoIdentityKeys,
  };
}

async function readCoworkWorkspace(
  entry: WorkspaceIndexEntry,
  collector?: ManifestAuthorityCollector,
  metadata?: PreparedW5Metadata,
): Promise<CoworkSidebarItem> {
  const [configRead, archivedContainerCount, workEntrySummary] =
    await settleAll([
      metadata
        ? consumeW5Metadata(metadata.manifest(entry.id))
        : readWorkspaceConfigDetailed(entry.id),
      readArchivedContainerCount(entry.id),
      readWorkEntrySidebarSummary(entry.id),
    ]);
  if (metadata) {
    await metadata.join();
    metadata.close();
  }
  collector?.record(entry.id, {
    file: 'manifest',
    authority: configRead.authority,
    ...(configRead.storedFields
      ? { storedFields: configRead.storedFields }
      : {}),
    externalPath: configRead.config.externalPath,
  });
  const config = configRead.config;
  return {
    id: entry.id,
    name: entry.name,
    type: 'cowork',
    privateMemory: config.privateMemory,
    privateMemoryManagedBy: config.privateMemoryManagedBy,
    color: entry.color,
    collapsed: entry.collapsed,
    order: entry.order,
    ...(entry.pinned === true ? { pinned: true } : {}),
    itemSortMode: config.itemSortMode,
    externalPath: config.externalPath,
    defaultPluginSelections: config.defaultPluginSelections,
    disabledGlobalPluginSelections: config.disabledGlobalPluginSelections,
    sharedTemplatePublicationKey: config.sharedTemplatePublicationKey,
    sharedTemplateExternalId: config.sharedTemplateExternalId,
    sharedTemplateContentHash: config.sharedTemplateContentHash,
    installedFromTemplateExternalId: config.installedFromTemplateExternalId,
    installedFromTemplateContentHash: config.installedFromTemplateContentHash,
    seededFromBlueprintExternalId: config.seededFromBlueprintExternalId,
    cowork: config.cowork,
    alwaysShow: config.alwaysShow,
    owner: config.owner,
    workEntryCount: workEntrySummary.count,
    lastActivityAt: workEntrySummary.lastActivityAt,
    archivedContainerCount,
    archiveRetentionDays: config.cowork?.archiveRetentionDays,
    autoArchiveDays: config.cowork?.autoArchiveDays,
  };
}

function toCoworkWorkspaceConfig(item: CoworkSidebarItem): WorkspaceConfigFile {
  return {
    version: 1,
    type: 'cowork',
    repoPath: undefined,
    // `privateMemory` and its managed marker are deliberately not carried,
    // as for code and multi-repo rows: a row is a projection that may be
    // stale, so the on-disk value stays (CAN-3562).
    repos: [],
    sourceRepoPath: undefined,
    suppressedRepoIds: undefined,
    temporary: undefined,
    externalPath: item.externalPath,
    cowork: item.cowork,
    defaultPluginSelections: item.defaultPluginSelections,
    disabledGlobalPluginSelections: item.disabledGlobalPluginSelections,
    sharedTemplatePublicationKey: item.sharedTemplatePublicationKey,
    sharedTemplateExternalId: item.sharedTemplateExternalId,
    sharedTemplateContentHash: item.sharedTemplateContentHash,
    installedFromTemplateExternalId: item.installedFromTemplateExternalId,
    installedFromTemplateContentHash: item.installedFromTemplateContentHash,
    seededFromBlueprintExternalId: item.seededFromBlueprintExternalId,
    alwaysShow: item.alwaysShow,
    owner: item.owner,
    itemSortMode: item.itemSortMode,
  };
}

async function readSingleRepoWorkspace(
  entry: WorkspaceIndexEntry,
  collector?: ManifestAuthorityCollector,
  metadata?: PreparedW5Metadata,
): Promise<SingleRepoSidebarItem | null> {
  const [configRead, worktreesRead, archivedContainerCount] = await settleAll([
    metadata
      ? consumeW5Metadata(metadata.manifest(entry.id))
      : readWorkspaceConfigDetailed(entry.id),
    metadata
      ? readPreparedW5Worktrees(metadata, entry.id)
      : readWorkspaceWorktreesDetailed(entry.id, collector?.readOptions),
    readArchivedContainerCount(entry.id),
  ]);
  if (metadata) {
    await metadata.join();
    metadata.close();
  }
  recordWorkspaceReads(collector, entry.id, configRead, worktreesRead);
  assertWorkspaceConfigReadable(configRead.authority);
  const config = configRead.config;
  const worktrees = worktreesRead.worktrees;

  if (!config.repoPath || !isAbsolute(config.repoPath)) {
    return null;
  }

  const rawScripts = normalizeLegacyScriptFields(config);
  const [resolvedScripts, resolvedHooks] = isW5ProjectionOnlyView()
    ? [{}, {}]
    : await settleAll([
        resolveProjectScripts({
          repoPath: config.repoPath,
          scripts: rawScripts,
        }),
        resolveProjectHooks({
          id: entry.id,
          owner: config.owner,
          repoPath: config.repoPath,
          hooks: config.hooks,
        }),
      ]);

  const repoPath = config.repoPath;
  const worktreeEffective = isW5ProjectionOnlyView()
    ? undefined
    : await resolveWorktreeEffective(entry.id, worktrees, (wtPath) =>
        settleAll([
          resolveProjectScripts(
            { repoPath, scripts: rawScripts },
            wtPath,
          ).catch(() => ({})),
          resolveProjectHooks(
            {
              id: entry.id,
              owner: config.owner,
              repoPath,
              hooks: config.hooks,
            },
            wtPath,
          ).catch(() => ({})),
        ]).then(([s, h]) => ({
          effectiveScripts: toScriptOverrides(s),
          effectiveHooks: toHookOverrides(h),
        })),
      );

  return {
    type: 'single-repo',
    privateMemory: config.privateMemory,
    privateMemoryManagedBy: config.privateMemoryManagedBy,
    id: entry.id,
    name: entry.name,
    repoPath: config.repoPath,
    color: entry.color,
    worktrees,
    collapsed: entry.collapsed,
    order: entry.order,
    ...(entry.pinned === true ? { pinned: true } : {}),
    itemSortMode: config.itemSortMode,
    defaultPluginSelections: config.defaultPluginSelections,
    disabledGlobalPluginSelections: config.disabledGlobalPluginSelections,
    scripts: rawScripts,
    effectiveScripts: toScriptOverrides(resolvedScripts),
    hooks: config.hooks,
    effectiveHooks: toHookOverrides(resolvedHooks),
    activitySectionOrder: entry.activitySectionOrder,
    alwaysShow: config.alwaysShow,
    owner: config.owner,
    worktreeEffective,
    externalPath: config.externalPath,
    archivedContainerCount,
    archiveRetentionDays: config.archiveRetentionDays,
    autoArchiveDays: config.autoArchiveDays,
    autoArchiveDeleteBranch: config.autoArchiveDeleteBranch,
    startPage: config.startPage,
  };
}

async function readMultiRepoWorkspace(
  entry: WorkspaceIndexEntry,
  collector?: ManifestAuthorityCollector,
  metadata?: PreparedW5Metadata,
): Promise<MultiRepoSidebarItem> {
  const [worktreesRead, configRead, archivedContainerCount] = await settleAll([
    metadata
      ? readPreparedW5Worktrees(metadata, entry.id)
      : readWorkspaceWorktreesDetailed(entry.id, collector?.readOptions),
    metadata
      ? consumeW5Metadata(metadata.manifest(entry.id))
      : readWorkspaceConfigDetailed(entry.id),
    readArchivedContainerCount(entry.id),
  ]);
  if (metadata) {
    await metadata.join();
    metadata.close();
  }
  recordWorkspaceReads(collector, entry.id, configRead, worktreesRead);
  assertWorkspaceConfigReadable(configRead.authority);
  const worktrees = worktreesRead.worktrees;
  const effectiveConfig = isW5ProjectionOnlyView()
    ? { ...configRead.config, localConfig: configRead.config }
    : await readEffectiveWorkspaceConfig(entry.id, configRead.config);
  const resolutionPaths = {
    localConfig: effectiveConfig.localConfig,
  };
  const [workspaceScripts, workspaceHooks, repos] = isW5ProjectionOnlyView()
    ? ([{}, {}, effectiveConfig.repos] as const)
    : await settleAll([
        resolveWorkspaceRootScripts(entry.id, resolutionPaths),
        resolveWorkspaceRootHooks(entry.id, resolutionPaths),
        settleAll(
          effectiveConfig.repos.map((repo) =>
            resolveWorkspaceRepoDataHooks(entry.id, repo, resolutionPaths),
          ),
        ),
      ]);

  const repoIds = effectiveConfig.repos.map((repo) => repo.id);
  const worktreeEffective = isW5ProjectionOnlyView()
    ? undefined
    : await resolveWorktreeEffective(
        entry.id,
        worktrees,
        async (wtPath, worktreeId) => {
          const paths = {
            workspaceRootPath: wtPath,
            localConfig: effectiveConfig.localConfig,
          };
          const [wtScripts, wtHooks] = await settleAll([
            resolveWorkspaceRootScripts(entry.id, paths).catch(() => ({})),
            resolveWorkspaceRootHooks(entry.id, paths).catch(() => ({})),
          ]);

          const repoEntries = await settleAll(
            repoIds.map(async (repoId) => {
              const repoPath = getWorkspaceWorktreeRepoDir(
                entry.id,
                worktreeId,
                repoId,
              );
              const repoPaths = {
                workspaceRootPath: wtPath,
                repoPath,
                localConfig: effectiveConfig.localConfig,
              };
              const [rs, rh] = await settleAll([
                resolveWorkspaceRepoScripts(entry.id, repoId, repoPaths).catch(
                  () => ({}),
                ),
                resolveWorkspaceRepoHooks(entry.id, repoId, repoPaths).catch(
                  () => ({}),
                ),
              ]);
              return [
                repoId,
                {
                  effectiveScripts: toScriptOverrides(rs),
                  effectiveHooks: toHookOverrides(rh),
                },
              ] satisfies [
                string,
                {
                  effectiveScripts?: ScriptOverrides;
                  effectiveHooks?: HookOverrides;
                },
              ];
            }),
          );

          return {
            effectiveScripts: toScriptOverrides(wtScripts),
            effectiveHooks: toHookOverrides(wtHooks),
            repos: Object.fromEntries(repoEntries),
          };
        },
      );

  return {
    type: 'multi-repo',
    privateMemory: effectiveConfig.localConfig.privateMemory,
    privateMemoryManagedBy: effectiveConfig.localConfig.privateMemoryManagedBy,
    id: entry.id,
    name: entry.name,
    color: entry.color,
    repos,
    worktrees,
    collapsed: entry.collapsed,
    order: entry.order,
    ...(entry.pinned === true ? { pinned: true } : {}),
    itemSortMode: effectiveConfig.localConfig.itemSortMode,
    defaultPluginSelections: effectiveConfig.defaultPluginSelections,
    disabledGlobalPluginSelections:
      effectiveConfig.localConfig.disabledGlobalPluginSelections,
    sourceRepoPath: effectiveConfig.sourceRepoPath,
    scripts: effectiveConfig.scripts,
    effectiveScripts: toScriptOverrides(workspaceScripts),
    hooks: effectiveConfig.hooks,
    effectiveHooks: toHookOverrides(workspaceHooks),
    suppressedRepoIds: effectiveConfig.suppressedRepoIds,
    activitySectionOrder: entry.activitySectionOrder,
    alwaysShow: effectiveConfig.alwaysShow,
    owner: effectiveConfig.owner,
    temporary: effectiveConfig.temporary === true ? true : undefined,
    ...(effectiveConfig.temporarySourceWorkspaceIds
      ? {
          temporarySourceWorkspaceIds:
            effectiveConfig.temporarySourceWorkspaceIds,
        }
      : {}),
    ...(effectiveConfig.temporaryRepoIdentityKeys
      ? {
          temporaryRepoIdentityKeys: effectiveConfig.temporaryRepoIdentityKeys,
        }
      : {}),
    worktreeEffective,
    externalPath: effectiveConfig.localConfig.externalPath,
    archivedContainerCount,
    archiveRetentionDays: effectiveConfig.localConfig.archiveRetentionDays,
    autoArchiveDays: effectiveConfig.localConfig.autoArchiveDays,
    autoArchiveDeleteBranch:
      effectiveConfig.localConfig.autoArchiveDeleteBranch,
    startPage: effectiveConfig.localConfig.startPage,
  };
}

async function resolveWorktreeEffective(
  workspaceId: string,
  worktrees: WorktreeData[],
  resolver: (
    worktreePath: string,
    worktreeId: string,
  ) => Promise<WorktreeEffectiveOverrides>,
): Promise<Record<string, WorktreeEffectiveOverrides>> {
  const entries = await settleAll(
    worktrees.map(async (wt) => {
      try {
        const wtPath = getWorkspaceWorktreeDir(workspaceId, wt.id);
        const overrides = await resolver(wtPath, wt.id);
        return [wt.id, overrides] as const;
      } catch {
        return null;
      }
    }),
  );
  const result: Record<string, WorktreeEffectiveOverrides> = {};
  for (const entry of entries) {
    if (entry) {
      result[entry[0]] = entry[1];
    }
  }
  return result;
}

function buildWorkspaceTypeMap(
  entries: WorkspaceIndexEntry[],
): Map<string, WorkspaceType> {
  const workspaceTypes = new Map<string, WorkspaceType>();
  for (const entry of entries) {
    workspaceTypes.set(entry.id, entry.type);
  }
  return workspaceTypes;
}

function buildWorkspaceExternalPathMap(
  items: SidebarItem[],
  failedWorkspaceIds: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const workspaceExternalPaths = new Map<string, string>();
  for (const item of items) {
    if (item.externalPath !== undefined) {
      workspaceExternalPaths.set(item.id, item.externalPath);
    }
  }
  failedWorkspaceIds.forEach((workspaceId) => {
    const previousExternalPath = getWorkspaceExternalPath(workspaceId);
    if (
      previousExternalPath !== null &&
      !workspaceExternalPaths.has(workspaceId)
    ) {
      workspaceExternalPaths.set(workspaceId, previousExternalPath);
    }
  });
  return workspaceExternalPaths;
}

function isEmptyTemporaryMultiRepoWorkspace(item: SidebarItem): boolean {
  return (
    item.type === 'multi-repo' &&
    item.temporary === true &&
    item.worktrees.length === 0
  );
}

function rememberSidebarItemIds(
  items: ReadonlyArray<Pick<SidebarItem, 'id'>>,
): void {
  lastKnownSidebarItemIds = new Set(items.map((item) => item.id));
}

async function preserveOmittedEmptyTemporaryWorkspaces(
  items: SidebarItem[],
): Promise<{
  items: SidebarItem[];
  preserveWorkspaceIds: string[];
}> {
  const itemIds = new Set(items.map((item) => item.id));
  if (
    lastKnownSidebarItemIds &&
    Array.from(lastKnownSidebarItemIds).every((id) => itemIds.has(id))
  ) {
    return { items, preserveWorkspaceIds: [] };
  }

  const existing = await readAllSidebarItems().catch(() => null);
  if (!existing) {
    return { items, preserveWorkspaceIds: [] };
  }

  const preserved = existing.items.filter(
    (item) => isEmptyTemporaryMultiRepoWorkspace(item) && !itemIds.has(item.id),
  );
  return {
    items: preserved.length > 0 ? [...items, ...preserved] : items,
    preserveWorkspaceIds: (existing.warnings ?? []).map(
      (warning) => warning.workspaceId,
    ),
  };
}

function createInvalidManifestWarning(
  entry: WorkspaceIndexEntry,
  error: InvalidCanopyJsonError,
): SidebarItemsLoadWarning {
  return {
    code: 'invalid-canopy-json',
    workspaceId: entry.id,
    workspaceName: entry.name,
    filePath: error.filePath,
    reason: error.reason,
  };
}

function createWorkspaceLoadWarning(
  entry: WorkspaceIndexEntry,
  error: unknown,
): SidebarItemsLoadWarning {
  const reason =
    error instanceof Error && error.message.trim().length > 0
      ? error.message
      : String(error) || 'Unknown project load error';
  return {
    code: 'workspace-load-failed',
    workspaceId: entry.id,
    workspaceName: entry.name,
    reason,
  };
}

/**
 * The workspace index entries alone, registering their workspace types as a
 * full sidebar read does. Startup work that needs only ids and types uses
 * this instead of {@link readAllSidebarItems}: projecting a workspace
 * resolves its scripts and hooks, which for a source-backed project can
 * create a default-branch checkout and wait on `git ls-remote` against its
 * remote before the first window opens.
 */
export async function readWorkspaceIndexEntries(): Promise<
  WorkspaceIndexEntry[]
> {
  const index = await readWorkspaceIndex();
  if (!isW5ProjectionOnlyView())
    registerWorkspaceTypes(buildWorkspaceTypeMap(index));
  return index;
}

export async function readAllSidebarItems(options?: {
  persistRemovalCleanup?: false;
}): Promise<SidebarItemsFile> {
  return (await readAllSidebarItemsSnapshot(options)).file;
}

/** Telemetry alone opts into discovery; ordinary sidebar/snapshot callers stay unchanged. */
export async function readSidebarItemsForTelemetry(): Promise<SidebarItemsFile> {
  const metadata = await prepareW5Metadata({ kind: 'discovery' });
  if (metadata.status === 'fallback') return readAllSidebarItems();
  try {
    return (await readAllSidebarItemsSnapshot(undefined, metadata)).file;
  } finally {
    await metadata.join();
    metadata.close();
  }
}

/** A registry refresh read the index or a manifest without authority. */
export class WorkspaceRegistriesDegradedError extends Error {
  constructor(
    readonly indexAuthority: WorkspaceIndexAuthority,
    /** Indexed workspaces whose manifest read was not authoritative. */
    readonly workspaceIds: readonly string[],
  ) {
    super('Workspace registries were not refreshed from authoritative reads.');
    this.name = 'WorkspaceRegistriesDegradedError';
  }
}

/**
 * Re-registers workspace types, external paths and known ids from a fresh
 * read, without persisting removal cleanup, after another origin committed
 * the index or a manifest (W5e, CAN-5497). External paths live in each
 * workspace's config, so this is the full projection, not the index alone.
 * Rejects, so the commit is retried, when the index was unreadable or an
 * indexed workspace's manifest was unreadable or never read; the registration
 * keeps what those reads could not decide. A `partial` index still resolves:
 * its unreadable entries stay in the file on every write and register nothing.
 */
export async function refreshWorkspaceRegistries(): Promise<void> {
  const snapshot = await readAllSidebarItemsSnapshot({
    persistRemovalCleanup: false,
  });
  const degraded = snapshot.indexedWorkspaceIds.filter(
    (workspaceId) =>
      !isAuthoritative(snapshot.workspaceReads.get(workspaceId)?.manifest),
  );
  if (snapshot.indexAuthority === 'unreadable' || degraded.length > 0)
    throw new WorkspaceRegistriesDegradedError(
      snapshot.indexAuthority,
      degraded,
    );
}

function isAuthoritative(
  authority: WorkspaceIndexAuthority | undefined,
): boolean {
  return authority === 'ok' || authority === 'absent';
}

/**
 * The sidebar items together with the authority of the reads they were
 * projected from; see {@link readAllSidebarItemsSnapshot}.
 */
export interface SidebarItemsSnapshot {
  file: SidebarItemsFile;
  authority: WorkspaceIndexAuthority;
  /** Authority of the index read alone, without the manifest reads. */
  indexAuthority: WorkspaceIndexAuthority;
  /** The named reason an unreadable index could not be read (CAN-5531, CAN-5542). */
  indexUnserved?: W5NamedUnreadableError;
  /**
   * Every workspace id in the index, including ones that could not be
   * projected into `file.items`.
   */
  indexedWorkspaceIds: string[];
  /** Each workspace's own reads, which `authority` folds together. */
  workspaceReads: Map<string, SidebarWorkspaceReads>;
  /**
   * Each of `file.items`' stored fields, at the same position, from the same
   * reads: the index fields of the item's own entry, even when another entry
   * repeats its id.
   */
  storedFields: SidebarWorkspaceStoredFields[];
}

/**
 * The sidebar items together with the authority of the reads they were
 * projected from: the workspace index and every workspace's `workspace.json`
 * and `worktrees.json`, all from this one projection, so a caller can never
 * pair items from one file state with the authority of another. Only `ok`
 * or `absent` proves that a workspace or worktree is gone; a workspace
 * that could not be projected from a readable config makes the snapshot
 * `partial`. It registers workspace types, external paths and known ids
 * from the reads that can decide them, keeping the rest as registered.
 */
export async function readAllSidebarItemsSnapshot(
  options?: {
    persistRemovalCleanup?: false;
  },
  metadata?: PreparedW5Metadata,
): Promise<SidebarItemsSnapshot> {
  const {
    entries: index,
    authority: indexAuthority,
    storedFields: indexStoredFields,
    unserved: indexUnserved,
  } = metadata
    ? await consumeW5Metadata(metadata.index)
    : await workspaceIndexRepository.readStored();
  let authority: WorkspaceIndexAuthority = indexAuthority;
  const workspaceReads = new Map<string, SidebarWorkspaceReads>();
  const manifestStoredFields = new Map<string, StoredWorkspaceManifestFields>();
  const manifestExternalPaths = new Map<string, string | undefined>();
  const collector: ManifestAuthorityCollector = {
    readOptions: isW5ProjectionOnlyView()
      ? { persistRemovalCleanup: false }
      : options,
    record: (workspaceId, read): void => {
      authority = weakerAuthority(authority, read.authority);
      const reads = workspaceReads.get(workspaceId) ?? {};
      workspaceReads.set(workspaceId, reads);
      if (read.file === 'manifest') {
        reads.manifest = read.authority;
        manifestExternalPaths.set(workspaceId, read.externalPath);
        if (read.storedFields)
          manifestStoredFields.set(workspaceId, read.storedFields);
        else manifestStoredFields.delete(workspaceId);
      } else {
        reads.worktrees = read.authority;
        if (read.recentlyRemovedWorktreeIds)
          reads.recentlyRemovedWorktreeIds = read.recentlyRemovedWorktreeIds;
      }
    },
  };
  const loaded = await settleAll(
    index.map(async (entry): Promise<ReadSidebarItemResult> => {
      try {
        if (entry.type === 'single-repo') {
          return {
            item: await readSingleRepoWorkspace(entry, collector, metadata),
          };
        }

        if (entry.type === 'cowork') {
          return {
            item: await readCoworkWorkspace(entry, collector, metadata),
          };
        }

        return {
          item: await readMultiRepoWorkspace(entry, collector, metadata),
        };
      } catch (error) {
        if (error instanceof InvalidCanopyJsonError) {
          return {
            item: null,
            warning: createInvalidManifestWarning(entry, error),
          };
        }
        return {
          item: null,
          warning: createWorkspaceLoadWarning(entry, error),
        };
      }
    }),
  );

  // An indexed workspace a reader could not project (for example a
  // single-repo config without an absolute repoPath) is simply left out of
  // the sidebar; that omission is not proof that its worktrees are gone,
  // so the snapshot is at best partial. A reader that threw is already a
  // warning, and warnings make a snapshot incomplete by themselves.
  if (
    loaded.some(
      (result) => result.item === null && result.warning === undefined,
    )
  ) {
    authority = weakerAuthority(authority, 'partial');
  }
  const projected = loaded
    .flatMap(({ item }, position) =>
      item ? [{ item, index: indexStoredFields[position] }] : [],
    )
    .sort((left, right) => left.item.order - right.item.order);
  const items = projected.map(({ item }, order) => ({ ...item, order }));
  const storedFields = projected.map(
    ({ item, index: stored }): SidebarWorkspaceStoredFields => {
      const manifest = manifestStoredFields.get(item.id);
      return {
        ...(stored ? { index: stored } : {}),
        ...(manifest ? { manifest } : {}),
      };
    },
  );
  const warnings: SidebarItemsLoadWarning[] = loaded
    .map((result) => result.warning)
    .filter(
      (warning): warning is SidebarItemsLoadWarning => warning !== undefined,
    );

  // An unreadable index lists nothing; registering it forgets everything.
  if (indexAuthority !== 'unreadable' && !isW5ProjectionOnlyView()) {
    const externalPaths = new Map<string, string>();
    for (const { id } of index) {
      // Only an ok or absent manifest read decides; otherwise keep the last.
      const externalPath = isAuthoritative(workspaceReads.get(id)?.manifest)
        ? manifestExternalPaths.get(id)
        : (getWorkspaceExternalPath(id) ?? undefined);
      if (externalPath !== undefined) externalPaths.set(id, externalPath);
    }
    registerWorkspaceTypes(buildWorkspaceTypeMap(index));
    registerWorkspaceExternalPaths(externalPaths);
    rememberSidebarItemIds(index);
  }
  return {
    file: {
      version: 1,
      items,
      ...(isW5ProjectionOnlyView() ? { stale: true } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    },
    authority,
    indexAuthority,
    ...(indexUnserved ? { indexUnserved } : {}),
    indexedWorkspaceIds: index.map((entry) => entry.id),
    workspaceReads,
    storedFields,
  };
}

async function findUnreadableSidebarProjects(
  items: readonly SidebarItem[],
): Promise<string[]> {
  const reads = await settleAll(
    items.map(async (item) => {
      const config = await readWorkspaceConfigDetailed(item.id);
      const unreadable =
        config.authority === 'unreadable' ||
        (item.type !== 'cowork' &&
          (await readWorkspaceWorktreesDetailed(item.id)).authority ===
            'unreadable');
      return { workspaceId: item.id, unreadable };
    }),
  );
  return reads
    .filter(({ unreadable }) => unreadable)
    .map(({ workspaceId }) => workspaceId);
}

/**
 * The `workspace.json` fields a sidebar item maps to, as a sidebar write
 * assigns them over the current file: a mapped field the item lacks is
 * cleared, and fields outside the mapping, such as `ownershipTransfer`,
 * `planDetection` or `personalCatalogId`, keep their on-disk values.
 */
export function toSidebarItemWorkspaceConfig(
  item: SidebarItem,
): WorkspaceConfigFile {
  return item.type === 'cowork'
    ? toCoworkWorkspaceConfig(item)
    : item.type === 'single-repo'
      ? toSingleRepoWorkspaceConfig(item)
      : toMultiRepoWorkspaceConfig(item);
}

/**
 * Writes the fields a sidebar item carries into the workspace's current
 * `workspace.json`. Fields the item does not carry, such as
 * `ownershipTransfer`, `planDetection` or `personalCatalogId`, keep their
 * on-disk values. Returns false, leaving the file untouched, when the file
 * cannot be read (CAN-3563).
 */
async function writeSidebarItemConfig(
  item: SidebarItem,
  ownership: WorkspaceConfigOwnershipWrite,
): Promise<boolean> {
  const itemConfig = toSidebarItemWorkspaceConfig(item);
  try {
    await updateWorkspaceConfig(
      item.id,
      (config): void => {
        Object.assign(config, itemConfig);
        // Binding a workspace sets its whole ownership, transfer included.
        if (ownership === 'replace') config.ownershipTransfer = undefined;
      },
      { ownership },
    );
    return true;
  } catch (error) {
    if (error instanceof WorkspaceConfigUnreadableError) return false;
    throw error;
  }
}

export function writeAllSidebarItems(
  ...args: Parameters<typeof writeAdmittedSidebarItems>
): Promise<SidebarItemsFile> {
  // Publishes index, then manifests, then lists: admits all before the first.
  return withStorageAdmission(PROJECT_W5_STORAGE, () =>
    writeAdmittedSidebarItems(...args),
  );
}

async function writeAdmittedSidebarItems(
  items: SidebarItem[],
  options?: SidebarItemsSaveOptions & {
    preserveEmptyTemporary?: boolean;
    deletedWorkspaceIds?: readonly string[];
    preserveUnmentionedWorkspaceIds?: boolean;
    /**
     * Workspaces whose `owner` binding this write sets. Every other workspace
     * keeps the ownership on disk (see `WorkspaceConfigOwnershipWrite`).
     */
    replaceOwnershipWorkspaceIds?: readonly string[];
  },
): Promise<SidebarItemsFile> {
  const preservedEmptyTemporary =
    options?.preserveEmptyTemporary === false
      ? { items, preserveWorkspaceIds: [] }
      : await preserveOmittedEmptyTemporaryWorkspaces(items);
  const itemsToWrite = preservedEmptyTemporary.items;
  validateSidebarItems(itemsToWrite);
  const deletedWorkspaceIds = new Set(options?.deletedWorkspaceIds ?? []);
  const preserveWorkspaceIds = new Set([
    ...preservedEmptyTemporary.preserveWorkspaceIds,
    ...(options?.preserveWorkspaceIds ?? []),
  ]);
  deletedWorkspaceIds.forEach((workspaceId) => {
    preserveWorkspaceIds.delete(workspaceId);
  });
  // A caller (for example a renderer still holding a project's last-good
  // item) may send an item whose config or registry is no longer readable.
  // Preserve it before writing either index metadata or configuration.
  (
    await findUnreadableSidebarProjects(
      itemsToWrite.filter((item) => !preserveWorkspaceIds.has(item.id)),
    )
  ).forEach((workspaceId) => {
    preserveWorkspaceIds.add(workspaceId);
  });
  const writtenIndex = await writeWorkspaceIndex(
    itemsToWrite,
    options?.replaceWorkspaceOrder === true,
    preserveWorkspaceIds,
    options?.preserveUnmentionedWorkspaceIds === true,
    deletedWorkspaceIds,
  );

  const replaceOwnership = new Set(options?.replaceOwnershipWorkspaceIds);
  // A failed project must not release admission while a sibling still writes.
  await settleAll(
    itemsToWrite.map(async (item) => {
      if (preserveWorkspaceIds.has(item.id)) {
        return;
      }
      const ownership = replaceOwnership.has(item.id) ? 'replace' : 'preserve';
      const configWritten = await writeSidebarItemConfig(item, ownership);
      if (!configWritten) {
        // The config became unreadable after the check above.
        preserveWorkspaceIds.add(item.id);
        return;
      }
      if (item.type !== 'cowork') {
        try {
          await writeWorkspaceWorktrees(item.id, item.worktrees);
        } catch (error) {
          if (!(error instanceof WorktreeRegistryUnreadableError)) throw error;
          // A whole-sidebar snapshot cannot repair unreadable canonical rows.
          // Return the existing preservation signal for this project while
          // allowing healthy projects to finish their independent writes.
          preserveWorkspaceIds.add(item.id);
        }
      }
    }),
  );

  const writtenWorkspaceIds = new Set(writtenIndex.map((entry) => entry.id));
  const incomingWorkspaceIds = new Set(itemsToWrite.map((item) => item.id));
  const writtenPreserveWorkspaceIds = new Set(
    Array.from(preserveWorkspaceIds).filter((workspaceId) =>
      writtenWorkspaceIds.has(workspaceId),
    ),
  );
  if (options?.preserveUnmentionedWorkspaceIds === true) {
    writtenIndex.forEach(({ id }) => {
      if (!incomingWorkspaceIds.has(id) && !deletedWorkspaceIds.has(id)) {
        writtenPreserveWorkspaceIds.add(id);
      }
    });
  }
  const writtenItems = itemsToWrite.filter(
    (item) =>
      writtenWorkspaceIds.has(item.id) &&
      !writtenPreserveWorkspaceIds.has(item.id),
  );
  await afterW5Commit(() => {
    registerWorkspaceTypes(buildWorkspaceTypeMap(writtenIndex));
    registerWorkspaceExternalPaths(
      buildWorkspaceExternalPathMap(writtenItems, writtenPreserveWorkspaceIds),
    );
    rememberSidebarItemIds(writtenIndex);
    notifyPortalStructureChanged();
  });
  const preservedWorkspaceIds = Array.from(writtenPreserveWorkspaceIds);
  return {
    version: 1,
    items: writtenItems,
    ...(preservedWorkspaceIds.length > 0 ? { preservedWorkspaceIds } : {}),
  };
}

/**
 * Persist the activity-section order for a single workspace without
 * round-tripping every other workspace's full config payload. Reads the
 * workspace index, mutates the matching entry's `activitySectionOrder`, and
 * writes the index back. Returns `true` when the workspace was found and
 * persisted, `false` otherwise.
 *
 * The portal command handler calls this after validating its payload so the
 * desktop UI and the portal stay in lockstep on the next reload.
 */
export async function setWorkspaceActivitySectionOrder(
  workspaceId: string,
  order: ActivitySectionId[],
): Promise<boolean> {
  const matched = await workspaceIndexRepository.update(({ entries }) => {
    let found = false;
    const next = entries.map((entry) => {
      if (entry.id !== workspaceId) return entry;
      found = true;
      return {
        ...entry,
        activitySectionOrder: order.length > 0 ? order : undefined,
      };
    });
    return found ? { result: true, entries: next } : { result: false };
  });
  if (matched) notifyPortalStructureChanged();
  return matched;
}

/**
 * Renames one index entry in place, touching nothing else.
 *
 * A workspace's display name lives only in `WorkspaceIndexEntry`, never in its
 * `workspace.json`, so a rename has no business round-tripping every
 * workspace's config through the lossy `SidebarItem -> WorkspaceConfigFile`
 * projection the way a full `writeAllSidebarItems` does — that projection
 * drops `recommendedPluginOptOutKeys` and `planDetection`. Same reasoning as
 * {@link setWorkspaceActivitySectionOrder}.
 *
 * `onlyWhenNamed` makes the write conditional under the same lock that reads
 * it, so a concurrent user rename cannot be clobbered by a stale check.
 *
 * Reports the index read's authority so one-shot callers can decline to
 * record themselves as done when the index was unreadable.
 */
export async function renameWorkspaceIndexEntry(
  workspaceId: string,
  nextName: string,
  onlyWhenNamed: readonly string[],
): Promise<{ authority: WorkspaceIndexAuthority; renamed: boolean }> {
  const outcome = await workspaceIndexRepository.update<{
    authority: WorkspaceIndexAuthority;
    renamed: boolean;
  }>(({ entries, authority }) => {
    // A one-shot caller records itself as done only after a rename from a
    // complete index, so a degraded read declines rather than writes.
    if (authority !== 'ok' && authority !== 'absent') {
      return { result: { authority, renamed: false } };
    }
    let renamed = false;
    const next = entries.map((entry) => {
      if (entry.id !== workspaceId || !onlyWhenNamed.includes(entry.name)) {
        return entry;
      }
      renamed = true;
      return { ...entry, name: nextName };
    });
    return renamed
      ? { result: { authority, renamed }, entries: next }
      : { result: { authority, renamed } };
  });
  if (outcome.renamed) notifyPortalStructureChanged();
  return outcome;
}

/**
 * Removes one workspace's index entry, touching nothing else: no manifest,
 * worktree list or workspace directory is written or removed, and every
 * other entry (including those this version cannot read) keeps its fields.
 * The remaining entries are renumbered to their position, as a whole-sidebar
 * write does. The change is applied to the index read inside the repository's
 * queue, so an entry another writer added meanwhile is kept (CAN-3799 F8);
 * an unreadable index is refused with `WorkspaceIndexUnreadableError`.
 *
 * Returns whether the entry was there. After the commit the workspace leaves
 * the type registry and the known sidebar ids, as after a whole-sidebar
 * write.
 */
export async function removeWorkspaceIndexEntry(
  workspaceId: string,
): Promise<boolean> {
  const remaining = await workspaceIndexRepository.update<
    WorkspaceIndexEntry[] | null
  >(({ entries, authority }) => {
    // An unreadable index cannot show the entry; asking for a write makes
    // the repository refuse it (and record the refusal) instead.
    if (authority === 'unreadable') return { result: null, entries: [] };
    if (!entries.some((entry) => entry.id === workspaceId)) {
      return { result: null };
    }
    const next = entries
      .filter((entry) => entry.id !== workspaceId)
      .map((entry, order) => ({ ...entry, order }));
    return { result: next, entries: next };
  });
  if (!remaining) return false;
  await afterW5Commit(() => {
    registerWorkspaceTypes(buildWorkspaceTypeMap(remaining));
    rememberSidebarItemIds(remaining);
    notifyPortalStructureChanged();
  });
  return true;
}

export function validateSidebarItems(items: SidebarItem[]): void {
  const seenIds = new Set<string>();

  for (const item of items) {
    validateId(item.id, 'item id');

    if (seenIds.has(item.id)) {
      throw new Error(`Duplicate sidebar item id: ${item.id}`);
    }
    seenIds.add(item.id);

    if (item.externalPath !== undefined && !isAbsolute(item.externalPath)) {
      throw new Error(
        `Invalid externalPath for project ${item.id}: must be an absolute path`,
      );
    }

    if (item.type === 'cowork') {
      continue;
    }

    if (item.type === 'single-repo') {
      if ('temporary' in item) {
        throw new Error(`temporary is only valid for multi-repo projects`);
      }
      if (!item.repoPath || !isAbsolute(item.repoPath)) {
        throw new Error(
          `Invalid repoPath for project ${item.id}: must be an absolute path`,
        );
      }
      validateWorktreeCompatibilitySymlinks(item.id, item.worktrees);
      continue;
    }

    if (item.sourceRepoPath !== undefined && !isAbsolute(item.sourceRepoPath)) {
      throw new Error(
        `Invalid sourceRepoPath for project ${item.id}: must be an absolute path`,
      );
    }

    for (const repo of item.repos) {
      if (!isAbsolute(repo.repoPath)) {
        throw new Error(
          `Invalid repoPath for project repo ${item.id}/${repo.id}: must be an absolute path`,
        );
      }
    }
    validateWorktreeCompatibilitySymlinks(item.id, item.worktrees);
  }
}

function validateWorktreeCompatibilitySymlinks(
  workspaceId: string,
  worktrees: WorktreeData[],
): void {
  for (const worktree of worktrees) {
    for (const link of worktree.compatibilitySymlinks ?? []) {
      if (!isAbsolute(link.path)) {
        throw new Error(
          `Invalid compatibilitySymlink.path for worktree ${workspaceId}/${worktree.id}: must be an absolute path`,
        );
      }
      if (!isAbsolute(link.targetPath)) {
        throw new Error(
          `Invalid compatibilitySymlink.targetPath for worktree ${workspaceId}/${worktree.id}: must be an absolute path`,
        );
      }
    }
  }
}
