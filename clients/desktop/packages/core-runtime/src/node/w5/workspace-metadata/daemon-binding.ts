import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CORE_WORKSPACE_ACTIVITY_SECTION_IDS,
  type CanopyJsonValue,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../../runtime/errors';
import { assertStorageWriteAllowed, STORAGE_OWNERSHIP } from '../../../storage';
import { IdentifierValidationError, validateId } from '../../identifiers';
import { createW5ExpectedRevisionCheck } from '../boundary-operation';
import {
  createW5CommitLogFileStore,
  type W5CommitLogFileStore,
  type W5CommitLogHostPort,
} from '../commit-log-file-store';
import type { W5CompositionPaths } from '../composition-operation';
import { readNodeW5File, type W5FileRead } from '../file-store';
import {
  projectW5HostPathFingerprint,
  type W5HostPathFlavor,
} from '../host-path-fingerprint';
import {
  createW5KeyedOperationRunner,
  type W5ReceiptStore,
} from '../keyed-operation';
import { w5RecordPathFor } from '../record-port/contract';
import type { W5SingleDecisionBindings } from '../single-decision-operation';
import { bindW5Storage, type W5StorageAdmission } from '../storage-binding';
import type { W5StorageTarget } from '../storage-target';
import {
  createWorkspaceIndexRepository,
  type StoredWorkspaceIndexRepository,
} from '../workspace-index-repository';
import {
  createWorkspaceManifestRepository,
  type WorkspaceManifestRead,
} from '../workspace-manifest-repository';
import { createW5DaemonManifestEditor } from './manifest-edit';
import {
  WORKSPACE_MANIFEST_KEYS,
  WORKSPACE_MANIFEST_REPOSITORY_KEYS,
} from './manifest-keys';
import {
  createWorkspaceMetadataCommands,
  type WorkspaceMetadataCommands,
} from './metadata';
import type { W5WorkspaceCommandHost, W5WorkspaceManifestView } from './ports';
import { createWorkspacePrivateMemoryCommand } from './private-memory';
import {
  w5MetadataUpdateOutcome,
  w5PrivateMemoryOutcome,
  w5ReorderOutcome,
  w5RepositoryAddOutcome,
  w5RepositoryRemoveOutcome,
} from './projectors';
import {
  createWorkspaceRepositoryCommands,
  type WorkspaceRepositoryCommands,
} from './repositories';
import { w5DaemonReceiptCaller } from './receipt-caller';
import { createW5DecisionOnlyRetry, type W5DecisionOnlyRetry } from './retry';
import {
  createWorkspaceSettingsCommands,
  type WorkspaceSettingsCommands,
} from './settings';

/*
 * The daemon binding of the W5 metadata command cores (W5d1, CAN-5522): the
 * same cores Electron main runs, over the daemon's own W5 host with the
 * `daemon` writer principal. Storage admission asserts ownership for every
 * target, so while the W5 rows are legacy nothing is reserved or written.
 * Hosted commits go through W5e's plain view, which shares the host's
 * final-decision queue with W6g's record authority, so an authority-routed
 * Electron write racing a hosted command is a pre-decision conflict. No
 * index or manifest commit hook is bound: publication is W5e's, once per
 * applied decision. Receipts name the authenticated principal
 * (`daemon:<principalId>:<source>`), never a lease or client instance, so a
 * retry after a lease fence or a restart replays. Each wire call of the
 * registered `core.workspace.*` commands (W7a) gets its own commands, which
 * address the call before any key is reserved (RR5).
 */

/** Matches desktop-shared's `SHARED_CONTAINER_VIEWER_PROJECT_ID`. */
export const W5_SHARED_CONTAINER_VIEWER_WORKSPACE_ID =
  'shared-container-viewer';
/** Matches desktop main's `READ_ONLY_SCOPE_ERROR`. */
const READ_ONLY_SCOPE_MESSAGE =
  'Shared-container recipient workspaces are read-only';

const ACTIVITY_SECTION_IDS: readonly string[] =
  CORE_WORKSPACE_ACTIVITY_SECTION_IDS;
const W5_NAMESPACES = [
  'workspace_index',
  'workspace_manifest',
  'worktree_list',
] as const;

/**
 * Refuses unless storage ownership admits the daemon for every W5 namespace,
 * before any receipt lookup, reservation or read: a keyed request's receipt
 * belongs to a W5 decision, as the record authority's do.
 */
export function assertW5DaemonHostingAdmitted(): void {
  for (const namespace of W5_NAMESPACES)
    assertStorageWriteAllowed(namespace, 'daemon', STORAGE_OWNERSHIP);
}

const admitDaemonStorage: W5StorageAdmission = (targets, operation) => {
  for (const target of targets)
    assertStorageWriteAllowed(
      target.namespace,
      target.writer,
      STORAGE_OWNERSHIP,
    );
  return operation();
};

function admitDaemonWrite<T>(
  target: W5StorageTarget,
  write: () => Promise<T>,
): Promise<T> {
  assertStorageWriteAllowed(target.namespace, target.writer, STORAGE_OWNERSHIP);
  return write();
}

function isActivitySectionId(value: string): value is string {
  return ACTIVITY_SECTION_IDS.includes(value);
}

/** The desktop index repository's activity-section read rule. */
function normalizeActivitySectionOrder(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: readonly unknown[] = value;
  const normalized = entries.filter(
    (entry): entry is string =>
      typeof entry === 'string' && isActivitySectionId(entry),
  );
  return normalized.length > 0 ? normalized : undefined;
}

function assertValidId(value: unknown, label: string): asserts value is string {
  validateId(value, label);
}

export interface W5DaemonMetadataBindingOptions {
  /**
   * The view hosted commits go through: W5e's plain `events.port()`, with no
   * `publishedBy`, since no process ran post-commit work for them.
   */
  readonly host: W5CommitLogHostPort;
  /** Direct reads outside the commit log; defaults to Node reads. */
  readonly readFile?: (filePath: string) => Promise<W5FileRead>;
  readonly warn?: (message: string, context: Record<string, unknown>) => void;
  /** The worker-plane Git probe (`git-dir`); absent, no folder is a repository. */
  readonly isRepository?: (repoPath: string) => Promise<boolean>;
  /**
   * How the host spells paths, for the keyed path fingerprint. The host names
   * it; this module reads no platform.
   */
  readonly pathFlavor: W5HostPathFlavor;
  /** Trusted owner-qualified lookup adapter; reservations retain the actual request. */
  readonly getReceiptStore?: (store: W5ReceiptStore) => W5ReceiptStore;
}

/** The seven commands, bound to one authenticated principal's receipts. */
export interface W5DaemonMetadataCommands {
  readonly metadata: WorkspaceMetadataCommands<string>;
  readonly settings: WorkspaceSettingsCommands;
  readonly updatePrivateMemory: ReturnType<
    typeof createWorkspacePrivateMemoryCommand
  >;
  readonly repositories: WorkspaceRepositoryCommands;
}

/** One wire call's admission and result hooks (W7a). */
export interface W5DaemonMetadataCall {
  /**
   * Addressing (RR5): runs only for a new key, after the receipt lookup and
   * before the reservation, so its refusal consumes no key.
   */
  readonly admitAddress: () => Promise<void>;
  /** Checks a repository change's manifest read inside the write queue. */
  readonly admitManifestRead?: (
    workspaceId: string,
    view: W5WorkspaceManifestView,
  ) => void;
  /** The workspace as an update's decision leaves it (version 2 outcomes). */
  readonly decidedWorkspace?: (workspaceId: string) => Promise<CanopyJsonValue>;
}

export interface W5DaemonMetadataBinding {
  /** The daemon's W5 root (`<data>/workspaces`). */
  readonly root: string;
  readonly store: W5CommitLogFileStore;
  /** The commands' bounded stale-file retry (A18′), with its counts. */
  readonly retry: W5DecisionOnlyRetry;
  /** The workspace index, as the commands read it. */
  readonly index: StoredWorkspaceIndexRepository;
  /** A workspace's stored `workspace.json`. */
  readManifest(workspaceId: string): Promise<WorkspaceManifestRead>;
  /** The commands for one wire call of `principalId`. */
  forCall(
    principalId: string,
    call: W5DaemonMetadataCall,
  ): W5DaemonMetadataCommands;
}

export function createW5DaemonMetadataBinding(
  options: W5DaemonMetadataBindingOptions,
): W5DaemonMetadataBinding {
  const { host, pathFlavor: flavor } = options;
  const { root } = host;
  const storage = bindW5Storage('daemon', admitDaemonStorage);
  const store = createW5CommitLogFileStore({
    getHost: () => host,
    warn: options.warn ?? ((): void => undefined),
    readFile: options.readFile ?? readNodeW5File,
    admit: storage.admit,
    admitWrite: admitDaemonWrite,
  });
  const paths: W5CompositionPaths = {
    workspaceIndex: () => w5RecordPathFor(root, { kind: 'index' }),
    workspaceManifest: (workspaceId) =>
      w5RecordPathFor(root, { kind: 'manifest', workspaceId }),
    worktreeList: (workspaceId) =>
      w5RecordPathFor(root, { kind: 'worktrees', workspaceId }),
  };
  const index = createWorkspaceIndexRepository<string>({
    store,
    filePath: paths.workspaceIndex,
    storage: storage.workspaceIndex,
    normalizeActivitySectionOrder,
    // No hooks: W5e publishes each applied decision once.
    onCommitted: (): void => undefined,
    onRefused: (): void => undefined,
  });
  const manifestRepository = createWorkspaceManifestRepository({
    store,
    filePath: paths.workspaceManifest,
    storage: storage.workspaceManifest,
    knownFields: new Set(WORKSPACE_MANIFEST_KEYS),
    knownRepoFields: new Set(WORKSPACE_MANIFEST_REPOSITORY_KEYS),
  });
  const manifest = createW5DaemonManifestEditor(manifestRepository);
  const runKeyed = createW5KeyedOperationRunner({
    getReceiptStore: () => options.getReceiptStore?.(store) ?? store,
  });
  const checkExpectedRevision = createW5ExpectedRevisionCheck((...args) =>
    store.readRevisions(...args),
  );
  const commandStorage = {
    index: storage.workspaceIndex,
    manifest: storage.workspaceManifest,
  };
  // Labelled by operation, which each command names as its wire operation.
  const retry = createW5DecisionOnlyRetry();

  function commandHost<Source extends string>(
    principalId: string,
    call: W5DaemonMetadataCall,
  ): W5WorkspaceCommandHost<Source> {
    const decision: W5SingleDecisionBindings<Source> = {
      runKeyed: (input, decode, work) =>
        runKeyed(
          {
            ...input,
            admit: async () => {
              await call.admitAddress();
              await input.admit?.();
            },
          },
          decode,
          work,
        ),
      admitStorage: storage.admit,
      caller: (source) => w5DaemonReceiptCaller(principalId, source),
      // A typed wire refusal the call's hooks throw comes before the decision.
      isHostRefusal: (error) =>
        error instanceof IdentifierValidationError ||
        error instanceof CanopyOperationError,
      retryStaleDecision: (operation, attempt) => retry.run(operation, attempt),
    };
    return {
      decision,
      checkExpectedRevision,
      withCommit: (commitOptions, work) =>
        store.withCommit(commitOptions, work),
      paths,
      validateId: assertValidId,
    };
  }

  /** Repository folders of the workspace's worktree checkouts. */
  async function checkoutRepoIds(workspaceId: string): Promise<string[]> {
    const taken: string[] = [];
    const worktreesRoot = join(root, workspaceId, 'worktrees');
    try {
      for (const worktree of await readdir(worktreesRoot, {
        withFileTypes: true,
      })) {
        if (!worktree.isDirectory()) continue;
        const repos = await readdir(
          join(worktreesRoot, worktree.name, 'repos'),
          {
            withFileTypes: true,
          },
        ).catch(() => []);
        for (const entry of repos)
          if (entry.isDirectory() || entry.isSymbolicLink())
            taken.push(entry.name);
      }
    } catch {
      // The worktrees directory may not exist yet.
    }
    return taken;
  }

  return {
    root,
    store,
    retry,
    index,
    readManifest: (workspaceId) => manifestRepository.read(workspaceId),
    forCall(principalId, call) {
      return {
        metadata: createWorkspaceMetadataCommands<string>({
          ...commandHost(principalId, call),
          index: () => index,
          manifest,
          storage: commandStorage,
          isActivitySectionId,
          serializeUpdate: (work) => work(),
          updateOutcome: w5MetadataUpdateOutcome,
          reorderOutcome: w5ReorderOutcome,
          afterUpdateStaged: () => Promise.resolve(),
          afterUpdate: () => Promise.resolve(),
          afterMoveStaged: () => Promise.resolve(),
          ...(call.decidedWorkspace && {
            decidedWorkspace: call.decidedWorkspace,
          }),
        }),
        settings: createWorkspaceSettingsCommands({
          ...commandHost(principalId, call),
          manifest,
          isWritableScope: (workspaceId) =>
            workspaceId !== W5_SHARED_CONTAINER_VIEWER_WORKSPACE_ID,
          readOnlyScopeMessage: READ_ONLY_SCOPE_MESSAGE,
        }),
        updatePrivateMemory: createWorkspacePrivateMemoryCommand({
          ...commandHost(principalId, call),
          manifest,
          storage: commandStorage,
          hasWorkspace: async (workspaceId) =>
            (await index.read()).entries.some(
              (entry) => entry.id === workspaceId,
            ),
          outcome: w5PrivateMemoryOutcome,
        }),
        repositories: createWorkspaceRepositoryCommands({
          ...commandHost(principalId, call),
          manifest,
          storage: commandStorage,
          isRepository: (repoPath) =>
            options.isRepository?.(repoPath) ?? Promise.resolve(false),
          checkoutRepoIds,
          ...(call.admitManifestRead && {
            admitManifestRead: call.admitManifestRead,
          }),
          // No script-actions notify (W7a adapter debt), so no operation id.
          afterAdd: (_workspaceId, repository) => Promise.resolve(repository),
          addOutcome: w5RepositoryAddOutcome,
          removeOutcome: w5RepositoryRemoveOutcome,
          // A path add hashes the path's fingerprint, never the path, as D8
          // asks of hosts. The hosted wire add is `addReferenced`, path-free.
          keyedParameters: (parameters) =>
            'repository' in parameters
              ? {
                  ...parameters,
                  repository: {
                    ...parameters.repository,
                    repoPath: projectW5HostPathFingerprint(
                      parameters.repository.repoPath,
                      flavor,
                    ),
                  },
                }
              : parameters,
        }),
      };
    },
  };
}
