import { isAbsolute, join } from 'node:path';
import type { WorkspaceIndexReadEntry } from '../workspace/read-formats';
import type { W5CommitLogFileStore } from './commit-log-file-store';
import type { W5FileStore } from './file-store';
import { w5RecordPathFor } from './record-port/contract';
import type { W5CaptureFile } from './commit-log/capture-contract';
import type { W5StorageTarget } from './storage-target';
import {
  createWorkspaceIndexRepository,
  type WorkspaceIndexRepositoryDeps,
  type StoredWorkspaceIndexRepository,
} from './workspace-index-repository';
import {
  createWorkspaceManifestRepository,
  type W5WorkspaceManifestConfig,
  type WorkspaceManifestRepositoryDeps,
  type WorkspaceManifestRepository,
} from './workspace-manifest-repository';
import {
  createWorktreeListRepository,
  type W5WorktreeListRow,
  type WorktreeListRepositoryDeps,
  type WorktreeListRepository,
} from './worktree-list-repository';

/** Staged record images only; a direct atomic file writer cannot bind here. */
export type W5RecordImageStore = W5FileStore &
  Pick<W5CommitLogFileStore, 'withCommit'>;

type Policy<Deps> = Omit<Deps, 'store' | 'filePath' | 'storage'> & {
  writer: W5StorageTarget['writer'];
};

export interface W5RecordImageRepositories {
  index<Section extends string>(
    policy: Policy<WorkspaceIndexRepositoryDeps<Section>>,
  ): StoredWorkspaceIndexRepository<WorkspaceIndexReadEntry<Section>>;
  manifest<Config extends W5WorkspaceManifestConfig>(
    policy: Policy<WorkspaceManifestRepositoryDeps>,
  ): WorkspaceManifestRepository<Config>;
  worktrees<Row extends W5WorktreeListRow>(
    policy: Policy<WorktreeListRepositoryDeps<Row>>,
  ): WorktreeListRepository<Row>;
}

type IndexReader<Section extends string = string> = Pick<
  StoredWorkspaceIndexRepository<WorkspaceIndexReadEntry<Section>>,
  'read' | 'readStored'
>;

export interface W5RecordImageReaders {
  index<Section extends string>(
    normalize: WorkspaceIndexRepositoryDeps<Section>['normalizeActivitySectionOrder'],
  ): IndexReader<Section>;
  backupIndex(): IndexReader;
  manifest(): Pick<WorkspaceManifestRepository, 'read'>;
  worktrees<Row extends W5WorktreeListRow>(
    readRow: WorktreeListRepositoryDeps<Row>['readRow'],
  ): Pick<WorktreeListRepository<Row>, 'read'>;
}

function validateRecordRoot(root: string): void {
  if (!isAbsolute(root)) throw new Error('W5 record root must be absolute');
}

function validateRecordWorkspace(workspaceId: string): void {
  if (
    !workspaceId ||
    workspaceId === '.' ||
    workspaceId === '..' ||
    /[/\\\0]/.test(workspaceId)
  )
    throw new Error('W5 record workspace ID must be a single path component');
}

function recordPaths(root: () => string): (target: W5CaptureFile) => string {
  return (target: W5CaptureFile): string => {
    const path = root();
    validateRecordRoot(path);
    if ('workspaceId' in target) validateRecordWorkspace(target.workspaceId);
    return w5RecordPathFor(path, target);
  };
}

/** Root-bound path projections; callers still need a read or staged-image port. */
export function w5IndexImagePath(root: string): string {
  validateRecordRoot(root);
  return join(root, 'index.json');
}

export function w5ManifestImagePath(root: string, workspaceId: string): string {
  validateRecordRoot(root);
  validateRecordWorkspace(workspaceId);
  return join(root, workspaceId, 'workspace.json');
}

export function w5WorktreesImagePath(
  root: string,
  workspaceId: string,
): string {
  validateRecordRoot(root);
  validateRecordWorkspace(workspaceId);
  return join(root, workspaceId, 'worktrees.json');
}

export interface W5RecordImagePaths {
  index(): string;
  manifest(workspaceId: string): string;
  worktrees(workspaceId: string): string;
}

/** Read/watch/diagnostic projections only; paths confer no write admission. */
export function createW5RecordImagePaths(
  root: () => string,
): W5RecordImagePaths {
  return {
    index: () => w5IndexImagePath(root()),
    manifest: (workspaceId) => w5ManifestImagePath(root(), workspaceId),
    worktrees: (workspaceId) => w5WorktreesImagePath(root(), workspaceId),
  };
}

/**
 * Core owns resource projection and repository semantics. These clients stage
 * images through the bound commit store; the authority remains the applicator.
 * `root` is the trusted host's workspaces root, resolved on each operation.
 */
export function createW5RecordImageRepositories(bindings: {
  root: () => string;
  store: W5RecordImageStore;
}): W5RecordImageRepositories {
  if (typeof bindings.store.withCommit !== 'function')
    throw new Error('W5 record images require a commit-backed store');
  const path = recordPaths(bindings.root);
  const { store } = bindings;
  return {
    index<Section extends string>(
      policy: Policy<WorkspaceIndexRepositoryDeps<Section>>,
    ): StoredWorkspaceIndexRepository<WorkspaceIndexReadEntry<Section>> {
      return createWorkspaceIndexRepository({
        ...policy,
        store,
        filePath: () => path({ kind: 'index' }),
        storage: { namespace: 'workspace_index', writer: policy.writer },
      });
    },
    manifest<Config extends W5WorkspaceManifestConfig>(
      policy: Policy<WorkspaceManifestRepositoryDeps>,
    ): WorkspaceManifestRepository<Config> {
      return createWorkspaceManifestRepository<Config>({
        ...policy,
        store,
        filePath: (workspaceId) => path({ kind: 'manifest', workspaceId }),
        storage: { namespace: 'workspace_manifest', writer: policy.writer },
      });
    },
    worktrees<Row extends W5WorktreeListRow>(
      policy: Policy<WorktreeListRepositoryDeps<Row>>,
    ): WorktreeListRepository<Row> {
      return createWorktreeListRepository<Row>({
        ...policy,
        store,
        filePath: (workspaceId) => path({ kind: 'worktrees', workspaceId }),
        storage: { namespace: 'worktree_list', writer: policy.writer },
      });
    },
  };
}

/** Read-only clients expose neither mutators nor a caller-supplied file path. */
export function createW5RecordImageReaders(bindings: {
  root: () => string;
  store: Pick<W5FileStore, 'read'>;
}): W5RecordImageReaders {
  const path = recordPaths(bindings.root);
  const refuse = (): Promise<never> =>
    Promise.reject(new Error('Read-only W5 record client cannot write'));
  const store: W5FileStore = {
    read: (filePath) => bindings.store.read(filePath),
    replace: refuse,
    remove: refuse,
  };
  function index<Section extends string>(
    normalizeActivitySectionOrder: WorkspaceIndexRepositoryDeps<Section>['normalizeActivitySectionOrder'],
    backup: boolean,
  ): IndexReader<Section> {
    const repository = createWorkspaceIndexRepository({
      store,
      filePath: () => path({ kind: backup ? 'index-backup' : 'index' }),
      storage: { namespace: 'workspace_index', writer: 'daemon' },
      normalizeActivitySectionOrder,
      onCommitted: () => undefined,
      onRefused: () => undefined,
    });
    return {
      read: () => repository.read(),
      readStored: () => repository.readStored(),
    };
  }
  return {
    index: <Section extends string>(
      normalize: WorkspaceIndexRepositoryDeps<Section>['normalizeActivitySectionOrder'],
    ): IndexReader<Section> => index(normalize, false),
    backupIndex: (): IndexReader => index(() => undefined, true),
    manifest(): Pick<WorkspaceManifestRepository, 'read'> {
      const repository = createWorkspaceManifestRepository({
        store,
        filePath: (workspaceId) => path({ kind: 'manifest', workspaceId }),
        storage: { namespace: 'workspace_manifest', writer: 'daemon' },
        knownFields: new Set(),
        knownRepoFields: new Set(),
      });
      return { read: (workspaceId) => repository.read(workspaceId) };
    },
    worktrees<Row extends W5WorktreeListRow>(
      readRow: WorktreeListRepositoryDeps<Row>['readRow'],
    ): Pick<WorktreeListRepository<Row>, 'read'> {
      const repository = createWorktreeListRepository({
        store,
        filePath: (workspaceId) => path({ kind: 'worktrees', workspaceId }),
        storage: { namespace: 'worktree_list', writer: 'daemon' },
        knownRowFields: new Set(),
        readRow,
      });
      return { read: (workspaceId) => repository.read(workspaceId) };
    },
  };
}
