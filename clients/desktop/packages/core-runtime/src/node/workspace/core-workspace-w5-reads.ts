import { isAbsolute } from 'node:path';
import { isProjectStartPage } from '@canopy/protocol/start-page';
import type { W5RecordImageReaders } from '../w5/record-image-repositories';
import type { WorkspaceManifestRead } from '../w5/workspace-manifest-repository';
import { readW5ManifestView } from '../w5/workspace-metadata/manifest-edit';
import type {
  W5WorktreeListReadRow,
  WorktreeListRead,
} from '../w5/worktree-list-repository';
import type { WorkspaceIndexReadEntry } from './read-formats';
import {
  normalizeCoreWorkspaceActivitySectionOrder,
  workspaceStorageUnavailable,
  type CoreWorkspaceManifestRead,
  type CoreWorkspaceProjectionReads,
  type CoreWorkspaceSidebarRead,
  type CoreWorkspaceSidebarWorkspace,
  type CoreWorktreeListRead,
  type CoreWorktreeRow,
} from './core-workspace-projection';

/*
 * The projection's read port over W5 record images alone (CAN-7239). It
 * decides what W5 data can: an unreadable manifest's fallback, a code
 * workspace left out for an unreadable manifest or a single-repo without an
 * absolute `repoPath`, unreadable entries and rows. What only Electron main
 * decides stays out: RR1 tombstones, the source overlay's repositories
 * (declared `external`), and workspaces its script, hook or work-entry
 * resolution fails to project.
 */

/** A manifest read as the desktop config read normalizes it. */
export function w5CoreWorkspaceManifestRead(
  read: WorkspaceManifestRead,
): CoreWorkspaceManifestRead & { readonly repoPath?: string } {
  // An absent or unreadable manifest reads as the default configuration.
  if (read.authority !== 'ok')
    return {
      authority: read.authority,
      type: 'multi-repo',
      repositories: [],
      fields: { alwaysShow: true },
    };
  const { document } = read;
  const { view } = readW5ManifestView(document);
  const { startPage } = document;
  return {
    authority: 'ok',
    type: view.type,
    ...(view.repoPath !== undefined && { repoPath: view.repoPath }),
    ...(view.sourceRepoPath !== undefined && {
      sourceRepoPath: view.sourceRepoPath,
    }),
    repositories: view.repos,
    ...(view.owner?.organizationId !== undefined && {
      organizationId: view.owner.organizationId,
    }),
    fields: {
      // Only an explicit opt-in to recency is stored; manual is the default.
      itemSortMode:
        document.itemSortMode === 'last-updated' ? 'last-updated' : 'manual',
      alwaysShow:
        typeof document.alwaysShow === 'boolean'
          ? document.alwaysShow
          : view.temporary === true
            ? undefined
            : true,
      ...((startPage === null || isProjectStartPage(startPage)) && {
        startPage,
      }),
    },
    stored: {
      itemSortMode: document.itemSortMode,
      alwaysShow: document.alwaysShow,
      startPage,
    },
  };
}

/** Optional fields of the wrong JSON type read as unset. */
function readRow(row: W5WorktreeListReadRow): CoreWorktreeRow {
  const { label, healthIssue, setupPhase, trackedBaseBranch } = row;
  return {
    id: row.id,
    branchName: row.branchName,
    createdAt: row.createdAt,
    ...(typeof label === 'string' && { label }),
    ...(healthIssue !== undefined && { healthIssue }),
    ...(setupPhase !== undefined && { setupPhase }),
    ...((typeof trackedBaseBranch === 'string' ||
      trackedBaseBranch === null) && { trackedBaseBranch }),
  };
}

function worktreeListRead(
  read: WorktreeListRead<CoreWorktreeRow>,
): CoreWorktreeListRead {
  return read.authority === 'ok'
    ? {
        rows: read.worktrees,
        authority: read.complete ? 'ok' : 'partial',
        recentlyRemoved: false,
      }
    : { rows: [], authority: read.authority, recentlyRemoved: false };
}

/** The list's overlay source, as the effective config read keeps it. */
function overlaySource(
  manifest: CoreWorkspaceManifestRead,
): string | undefined {
  return manifest.type === 'single-repo' || !manifest.sourceRepoPath
    ? undefined
    : manifest.sourceRepoPath;
}

export function createW5CoreWorkspaceProjectionReads(
  readers: W5RecordImageReaders,
): CoreWorkspaceProjectionReads {
  const index = readers.index(normalizeCoreWorkspaceActivitySectionOrder);
  const manifests = readers.manifest();
  const worktrees = readers.worktrees<CoreWorktreeRow>(readRow);
  const readManifest = async (
    workspaceId: string,
  ): Promise<ReturnType<typeof w5CoreWorkspaceManifestRead>> =>
    w5CoreWorkspaceManifestRead(await manifests.read(workspaceId));
  const readWorktrees = async (
    workspaceId: string,
  ): Promise<CoreWorktreeListRead> =>
    worktreeListRead(await worktrees.read(workspaceId));

  /** Null for a workspace a listing leaves out. */
  async function sidebarWorkspace(
    entry: WorkspaceIndexReadEntry<string>,
    indexStored: Record<string, unknown> | undefined,
  ): Promise<CoreWorkspaceSidebarWorkspace | null> {
    const [manifest, list] = await Promise.all([
      readManifest(entry.id),
      entry.type === 'cowork' ? undefined : readWorktrees(entry.id),
    ]);
    if (entry.type !== 'cowork') {
      // A code workspace is never built from the default configuration.
      if (manifest.authority === 'unreadable') return null;
      if (
        entry.type === 'single-repo' &&
        (!manifest.repoPath || !isAbsolute(manifest.repoPath))
      )
        return null;
    }
    const sourceRepoPath = overlaySource(manifest);
    return {
      index: entry,
      ...(indexStored && { indexStored }),
      ...(manifest.authority && { manifestAuthority: manifest.authority }),
      ...(manifest.authority === 'ok' && {
        manifest: { fields: manifest.fields, stored: manifest.stored },
      }),
      ...(manifest.organizationId !== undefined && {
        organizationId: manifest.organizationId,
      }),
      repositories: manifest.repositories,
      ...(sourceRepoPath !== undefined && { sourceRepoPath }),
      ...(list && { worktrees: list }),
    };
  }

  return {
    async readSidebar(): Promise<CoreWorkspaceSidebarRead> {
      const snapshot = await index.readStored();
      const loaded = await Promise.all(
        snapshot.entries.map(async (entry, position) => {
          try {
            const workspace = await sidebarWorkspace(
              entry,
              snapshot.storedFields[position],
            );
            return workspace && { workspace, order: entry.order };
          } catch {
            // A workspace whose reads fail is left out, as the sidebar does.
            return null;
          }
        }),
      );
      return {
        indexAuthority: snapshot.authority,
        indexedWorkspaceIds: snapshot.entries.map((entry) => entry.id),
        workspaces: loaded
          .flatMap((entry) => (entry ? [entry] : []))
          .sort((left, right) => left.order - right.order)
          .map(({ workspace }) => workspace),
      };
    },
    async readIndexEntry(workspaceId) {
      const snapshot = await index.readStored();
      if (snapshot.authority === 'unreadable')
        throw workspaceStorageUnavailable(snapshot.unserved);
      // The first entry with the id.
      const position = snapshot.entries.findIndex(
        (candidate) => candidate.id === workspaceId,
      );
      const entry = snapshot.entries[position];
      const stored = snapshot.storedFields[position];
      return entry && stored ? { entry, stored } : null;
    },
    readManifest,
    readWorktrees,
  };
}
