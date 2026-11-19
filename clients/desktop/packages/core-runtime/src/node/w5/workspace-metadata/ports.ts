import type { WorkspacePlanDetectionConfig } from '@canopy/protocol/plan-detection';
import type { ScriptOverrides } from '@canopy/protocol/scripts';
import type { ProjectStartPage } from '@canopy/protocol/start-page';
import type { W5ExpectedRevisionCheck } from '../boundary-operation';
import type {
  W5CommitRunner,
  W5CompositionPaths,
} from '../composition-operation';
import type { W5SingleDecisionBindings } from '../single-decision-operation';
import type { W5StorageTarget } from '../storage-target';

export type W5SidebarSortMode = 'last-updated' | 'manual';

/** A `repos[]` entry as the metadata commands read and write it. */
export interface W5ManifestRepositoryView {
  id: string;
  name: string;
  repoPath: string;
  source?: 'local' | 'manifest';
  manifestUrl?: string;
  scripts?: ScriptOverrides;
}

/**
 * The manifest fields the metadata commands decide from. A host may pass a
 * richer object; commands never mutate it.
 */
export interface W5WorkspaceManifestView {
  type: 'single-repo' | 'multi-repo' | 'cowork';
  repos: readonly W5ManifestRepositoryView[];
  scripts?: ScriptOverrides;
  privateMemoryManagedBy?: 'organization';
  /** Organization ownership; absent means Personal. */
  owner?: { readonly type?: string; readonly organizationId?: string };
  repoPath?: string;
  sourceRepoPath?: string;
  /** A multi-repo's only. */
  temporary?: boolean;
}

/**
 * The fields one edit replaces. A field present with `undefined` is removed;
 * no command clears `privateMemory` or `repos`. A repository the edit keeps
 * carries the view's other fields, so the host keeps them.
 */
export interface W5WorkspaceManifestChange {
  itemSortMode?: W5SidebarSortMode;
  alwaysShow?: boolean;
  startPage?: ProjectStartPage | null;
  scripts?: ScriptOverrides;
  planDetection?: WorkspacePlanDetectionConfig;
  privateMemory?: boolean;
  repos?: W5ManifestRepositoryView[];
}

/** What an edit read inside the manifest write queue. */
export interface W5ManifestEditRead {
  /** `absent`: the view is the default configuration of no stored file. */
  authority: 'ok' | 'absent';
  memoryMalformed: boolean;
}

export interface W5ManifestEdit<T> {
  result: T;
  /** Omitted: nothing is written. */
  change?: W5WorkspaceManifestChange;
}

export type W5ManifestEditOutcome<T> =
  | { status: 'edited'; result: T }
  /** The manifest could not be read, so it was left as it is. */
  | { status: 'unreadable'; message: string };

/**
 * The host's `workspace.json` writer. Plugin-default fields are never part of
 * a change, so a host's chat normalization never runs for these commands.
 */
export interface W5WorkspaceManifestEditor {
  /** The stored manifest's authority, read outside the write queue. */
  readAuthority(workspaceId: string): Promise<'ok' | 'absent' | 'unreadable'>;
  /**
   * One read-modify-write in the workspace's manifest write queue: `apply`
   * decides from that read, and a refusal it throws rejects the edit with
   * nothing written.
   */
  edit<T>(
    workspaceId: string,
    apply: (
      view: W5WorkspaceManifestView,
      read: W5ManifestEditRead,
    ) => W5ManifestEdit<T> | Promise<W5ManifestEdit<T>>,
  ): Promise<W5ManifestEditOutcome<T>>;
}

/** What every metadata command family takes from its host. */
export interface W5WorkspaceCommandHost<Source extends string> {
  decision: W5SingleDecisionBindings<Source>;
  checkExpectedRevision: W5ExpectedRevisionCheck;
  withCommit: W5CommitRunner;
  paths: W5CompositionPaths;
  /** Throws the host's identifier refusal. */
  validateId: (value: unknown, label: string) => asserts value is string;
}

/** The host's writer principals for the files the commands write. */
export interface W5WorkspaceCommandStorage {
  index: W5StorageTarget;
  manifest: W5StorageTarget;
}
