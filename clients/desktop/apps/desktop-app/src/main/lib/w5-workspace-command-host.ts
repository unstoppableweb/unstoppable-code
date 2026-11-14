import type {
  W5ManifestEdit,
  W5ManifestEditOutcome,
  W5ManifestEditRead,
  W5WorkspaceCommandHost,
  W5WorkspaceCommandStorage,
  W5WorkspaceManifestChange,
  W5WorkspaceManifestEditor,
  W5WorkspaceManifestView,
} from '@canopy/core-runtime/node/w5/workspace-metadata/ports';
import { CanopyOperationError } from '@canopy/core-runtime';
import { w5DaemonReceiptCaller } from '@canopy/core-runtime/node/w5/workspace-metadata/receipt-caller';
import type { WorkspaceConfigFile } from '@canopy/desktop-shared/types';
import { w5RecordReadPaths } from './paths';
import { validateId } from './validation';
import { checkW5ExpectedRevision } from './w5-boundary-operation';
import { withW5Commit } from './w5-commit-log-file-store';
import { runW5DecisionOnlyUnit } from './w5-pre-effect-retry';
import { desktopW5SingleDecisionBindings } from './w5-single-decision-operation';
import {
  WORKSPACE_INDEX_STORAGE,
  WORKSPACE_MANIFEST_STORAGE,
} from './w5-storage';
import {
  readWorkspaceConfigDetailed,
  updateWorkspaceConfig,
  WorkspaceConfigUnreadableError,
} from './workspace-persistence';

/*
 * Desktop main's bindings for the core-runtime workspace metadata command
 * cores (CAN-5520). Each binding resolves at call time, so test injection and
 * spies still intercept.
 */

function assertValidId(value: unknown, label: string): asserts value is string {
  validateId(value, label);
}

/**
 * The single-decision runner, revision check, commit, paths and id check.
 * The runner reruns a stale-file refusal as the hosted commands do (O-2).
 */
export function desktopW5WorkspaceCommandHost<
  Source extends string,
>(): W5WorkspaceCommandHost<Source> {
  return {
    decision: {
      ...desktopW5SingleDecisionBindings<Source>(),
      retryStaleDecision: (operation, attempt) =>
        runW5DecisionOnlyUnit(operation, attempt),
    },
    checkExpectedRevision: (resource, expected) =>
      checkW5ExpectedRevision(resource, expected),
    withCommit: (options, work) => withW5Commit(options, work),
    paths: {
      workspaceIndex: () => w5RecordReadPaths.index(),
      workspaceManifest: (workspaceId) =>
        w5RecordReadPaths.manifest(workspaceId),
      worktreeList: (workspaceId) => w5RecordReadPaths.worktrees(workspaceId),
    },
    validateId: assertValidId,
  };
}

/**
 * The same host for one wire call of a registered `core.workspace.*` command
 * (W7a): receipts name the authenticated principal with CAN-5522's
 * derivation (`daemon:<principalId>:<source>`), so W7a-3's daemon replays
 * them, and `admitAddress` runs only for a new key, after the receipt lookup
 * and before the reservation (RR5). A `CanopyOperationError` the decision
 * throws is a refusal before it.
 */
export function desktopW5WireCommandHost<Source extends string>(
  principalId: string,
  admitAddress: () => Promise<void>,
): W5WorkspaceCommandHost<Source> {
  const host = desktopW5WorkspaceCommandHost<Source>();
  const { decision } = host;
  return {
    ...host,
    decision: {
      ...decision,
      runKeyed: (input, decode, work) =>
        decision.runKeyed(
          {
            ...input,
            admit: async () => {
              await admitAddress();
              await input.admit?.();
            },
          },
          decode,
          work,
        ),
      caller: (source) => w5DaemonReceiptCaller(principalId, source),
      isHostRefusal: (error) =>
        decision.isHostRefusal(error) || error instanceof CanopyOperationError,
    },
  };
}

export const DESKTOP_W5_WORKSPACE_COMMAND_STORAGE: W5WorkspaceCommandStorage = {
  index: WORKSPACE_INDEX_STORAGE,
  manifest: WORKSPACE_MANIFEST_STORAGE,
};

/** Each change field's assignment; every field must have one. */
const MANIFEST_CHANGE_FIELDS: {
  [K in keyof W5WorkspaceManifestChange]-?: (
    config: WorkspaceConfigFile,
    change: W5WorkspaceManifestChange,
  ) => void;
} = {
  itemSortMode: (config, change) => {
    config.itemSortMode = change.itemSortMode;
  },
  alwaysShow: (config, change) => {
    config.alwaysShow = change.alwaysShow;
  },
  startPage: (config, change) => {
    config.startPage = change.startPage;
  },
  scripts: (config, change) => {
    config.scripts = change.scripts;
  },
  planDetection: (config, change) => {
    config.planDetection = change.planDetection;
  },
  privateMemory: (config, change) => {
    config.privateMemory = change.privateMemory;
  },
  repos: (config, change) => {
    if (change.repos) config.repos = change.repos;
  },
};

function isManifestChangeField(
  key: string,
): key is keyof W5WorkspaceManifestChange {
  return Object.prototype.hasOwnProperty.call(MANIFEST_CHANGE_FIELDS, key);
}

/**
 * One edit through the guarded config read-modify-write: the change lands on
 * the config read in the write queue, and the config write keeps its
 * normalization and post-commit effects. Nothing is written without a change.
 */
async function editWorkspaceManifest<T>(
  workspaceId: string,
  apply: (
    view: W5WorkspaceManifestView,
    read: W5ManifestEditRead,
  ) => W5ManifestEdit<T> | Promise<W5ManifestEdit<T>>,
): Promise<W5ManifestEditOutcome<T>> {
  try {
    const edit = await updateWorkspaceConfig(
      workspaceId,
      async (config, read): Promise<W5ManifestEdit<T>> => {
        const decided = await apply(config, read);
        const { change } = decided;
        if (change)
          for (const key of Object.keys(change))
            if (isManifestChangeField(key))
              MANIFEST_CHANGE_FIELDS[key](config, change);
        return decided;
      },
      { shouldWrite: (decided) => decided.change !== undefined },
    );
    return { status: 'edited', result: edit.result };
  } catch (error) {
    if (error instanceof WorkspaceConfigUnreadableError)
      return { status: 'unreadable', message: error.message };
    throw error;
  }
}

export const desktopW5WorkspaceManifestEditor: W5WorkspaceManifestEditor = {
  readAuthority: async (workspaceId) =>
    (await readWorkspaceConfigDetailed(workspaceId)).authority,
  edit: editWorkspaceManifest,
};
