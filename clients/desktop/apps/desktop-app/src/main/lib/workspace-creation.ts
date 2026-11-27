import { randomUUID } from 'node:crypto';
import { notifyScriptActionsRepositoryAdd } from '../services/script-actions-lifecycle';
import {
  SINGLE_REPO_USAGE_REPO_ID,
  WORKSPACE_ROOT_REPO_ID,
} from '@canopy/desktop-shared/types';
import { CloneCancelledError } from '../services/clone-jobs';
import { z } from 'zod';
import type { W5CommitOptions } from './w5-commit-scope';
import { runKeyedW5Operation, type W5KeyedAttempt } from './w5-keyed-operation';
import {
  admitImportFolder,
  admitWorkspaceCreation,
  afterWorkspaceCreationCommit,
  routeWorkspaceCreation,
  workspaceCreationKeyedRequest,
  WorkspaceCreationRefusedError,
  type CoreWorkspaceCreationVariant,
  type WorkspaceCreateAfterCommitPort,
  type WorkspaceCreateFilesPort,
  type WorkspaceCreationRoutes,
} from '@canopy/core-runtime/node/workspace/create-orchestration';
import type { DesktopWorkspaceCreateTypes } from '@canopy/desktop-shared/node/worktree-record-decisions';
import { CoworkWorkspaceRecordRefusedError } from './cowork-workspace-records';
import { IdentifierValidationError } from './identifier-validation-error';
import { withWorkspaceCreationCommit } from './w5-workspace-creation-commit';
import { withW5Commit } from './w5-commit-log-file-store';
import { afterW5Commit } from './w5-commit-scope';
import type { SidebarItem } from '@canopy/desktop-shared/types';
import {
  assertImportFolderExists,
  ImportFolderNotFoundError,
} from '@canopy/desktop-shared/node/lib/import-folder';
import { recordWorkspaceCrudTelemetry } from './desktop-telemetry';
import { PROJECT_W5_STORAGE, withStorageAdmission } from './w5-storage';
import {
  addWorkspaceFromRemote,
  createAndPersistNewMultiRepoWorkspace,
  registerBoundMultiRepoWorkspace,
  registerCloudProjectMultiRepoWorkspace,
  createNewSingleRepoWorkspace,
  importMultiRepoWorkspaceManifestFromRepo,
  importWorkspaceFromRepoPath,
  registerSingleRepoWorkspaceWithoutManifest,
  WorkspaceIdentityInUseError,
  type AddWorkspaceFromRemoteProgress,
} from './workspace-service';

/** The caller of a create or import, recorded in workspace CRUD telemetry. */
export type WorkspaceCreationSource =
  | 'new_single_repo'
  | 'new_multi_repo'
  | 'folder'
  | 'remote'
  | 'import_from_repo'
  | 'portal'
  | 'org-shared-multi-repo-setup'
  | 'org-member-multi-repo-create'
  /** A Personal cloud project set up on this device (CAN-5192). */
  | 'cloud-project-setup'
  | 'shared_container_fork'
  | 'external_projects_import'
  /** A registered `core.workspace.create` wire call (W7b-3). */
  | 'desktop_canopy_client';

/**
 * Host-direct variants core does not orchestrate: compatibility debt of their
 * organization and cloud callers (CAN-4096 C1 inventory).
 */
type HostDirectWorkspaceCreationVariant =
  /**
   * Host-only, validated complete clone with its organization binding, or a
   * new organization copy's staged checkouts (CAN-4856, `copyRepositories`).
   */
  | ({ kind: 'bound-multi-repo' } & Parameters<
      typeof registerBoundMultiRepoWorkspace
    >[0])
  /** Host-only, validated clones of a Personal cloud project (CAN-5192). */
  | ({ kind: 'cloud-project-multi-repo' } & Parameters<
      typeof registerCloudProjectMultiRepoWorkspace
    >[0]);

/** The supported create and import variants. */
export type WorkspaceCreationVariant =
  | CoreWorkspaceCreationVariant<AddWorkspaceFromRemoteProgress>
  | HostDirectWorkspaceCreationVariant;

export interface WorkspaceCreationRequest {
  source: WorkspaceCreationSource;
  variant: WorkspaceCreationVariant;
  /** The workspaces collection revision read before this create. */
  expectedRevision?: number;
  idempotencyKey?: string;
  /**
   * A keyed wire call's receipt caller (W7b-3), derived from its principal;
   * defaults to `desktop-host:<source>`. Never part of the fingerprint.
   */
  receiptCaller?: string;
}

export interface WorkspaceCreationOutcome {
  /** The workspace as the create indexed it. */
  workspace: SidebarItem;
  /** The manifest repositories a manifest import cloned; otherwise empty. */
  clonedRepoIds: string[];
  /** Poll this operation through scriptActions.receipt after an add. */
  scriptActionsOperationId?: string;
}

const receiptOutcomeSchema = z.object({
  workspace: z.object({
    id: z.string(),
    name: z.string(),
    type: z.enum(['single-repo', 'multi-repo', 'cowork']),
    color: z.string(),
    order: z.number(),
    collapsed: z.boolean().optional(),
  }),
  clonedRepoIds: z.array(z.string()),
  scriptActionsOperationId: z.string().optional(),
});
/** The create DTO projected to portable identity/display fields for a keyed call. */
export type WorkspaceCreationReceiptOutcome = z.infer<
  typeof receiptOutcomeSchema
>;
function projectReceiptOutcome(
  workspace: SidebarItem,
  clonedRepoIds: string[],
  scriptActionsOperationId?: string,
): WorkspaceCreationReceiptOutcome {
  return receiptOutcomeSchema.parse({
    workspace,
    clonedRepoIds,
    scriptActionsOperationId,
  });
}

const files: WorkspaceCreateFilesPort = {
  async missingImportFolder(path) {
    try {
      await assertImportFolderExists(path);
      return undefined;
    } catch (error) {
      if (error instanceof ImportFolderNotFoundError) return error.message;
      throw error;
    }
  },
};

const afterCommit: WorkspaceCreateAfterCommitPort<
  DesktopWorkspaceCreateTypes,
  WorkspaceCreationSource
> = {
  afterCommit: (effect) => afterW5Commit(effect),
  recordCreated: (workspaceId, source) =>
    recordWorkspaceCrudTelemetry({ action: 'create', workspaceId, source }),
  scriptActionsRepoIds: (workspace) =>
    workspace.type === 'cowork'
      ? undefined
      : workspace.type === 'single-repo'
        ? [SINGLE_REPO_USAGE_REPO_ID]
        : [...workspace.repos.map((repo) => repo.id), WORKSPACE_ROOT_REPO_ID],
  newOperationId: () => randomUUID(),
  notifyRepositoryAdd: (workspaceId, repoIds, operationId) => {
    notifyScriptActionsRepositoryAdd(workspaceId, repoIds, operationId);
  },
};

const routes: WorkspaceCreationRoutes<
  AddWorkspaceFromRemoteProgress,
  WorkspaceCreationOutcome
> = {
  newSingleRepo: async (name) => ({
    workspace: await createNewSingleRepoWorkspace(name),
    clonedRepoIds: [],
  }),
  newMultiRepo: async (name) => ({
    workspace: await createAndPersistNewMultiRepoWorkspace(name),
    clonedRepoIds: [],
  }),
  localFolder: async (folderPath) => ({
    workspace: await importWorkspaceFromRepoPath(folderPath),
    clonedRepoIds: [],
  }),
  repositoryManifest: (repoPath) =>
    importMultiRepoWorkspaceManifestFromRepo(repoPath),
  repositoryWithoutManifest: async (repoPath, name) => ({
    workspace: await registerSingleRepoWorkspaceWithoutManifest(repoPath, name),
    clonedRepoIds: [],
  }),
  remoteClone: async (remoteUrl, destinationDir, progress) => ({
    workspace: progress
      ? await addWorkspaceFromRemote(remoteUrl, destinationDir, progress)
      : await addWorkspaceFromRemote(remoteUrl, destinationDir),
    clonedRepoIds: [],
  }),
};

function isHostDirect(
  variant: WorkspaceCreationVariant,
): variant is HostDirectWorkspaceCreationVariant {
  return (
    variant.kind === 'bound-multi-repo' ||
    variant.kind === 'cloud-project-multi-repo'
  );
}

/** The checks that need no index read; each refuses before any effect. */
async function admitCreation(
  variant: WorkspaceCreationVariant,
  inspectFolder = true,
): Promise<void> {
  if (isHostDirect(variant))
    return admitImportFolder(variant.path, inspectFolder, files);
  return admitWorkspaceCreation(variant, inspectFolder, files);
}

async function runCreation(
  variant: WorkspaceCreationVariant,
): Promise<WorkspaceCreationOutcome> {
  switch (variant.kind) {
    case 'bound-multi-repo':
      return {
        workspace: await registerBoundMultiRepoWorkspace(variant),
        clonedRepoIds: (variant.copyRepositories ?? variant.repositories).map(
          (entry) => entry.relativePath.slice('repos/'.length),
        ),
      };
    case 'cloud-project-multi-repo':
      return {
        workspace: await registerCloudProjectMultiRepoWorkspace(variant),
        clonedRepoIds: variant.repositories.map((repo) => repo.id),
      };
    default:
      return routeWorkspaceCreation(variant, routes);
  }
}

/**
 * The typed in-process workspace create and import boundary (CAN-3806),
 * behind the renderer's create and import channels, the Portal's
 * `portal.workspace.create`, organization project creation, shared-container
 * forks and the external project import. It refuses before any effect while
 * the W5 namespaces are not writable here, and checks names, paths and the
 * folder's existence first. Each variant then runs the desktop lifecycle,
 * which allocates the id and checks duplicates inside the commit that
 * indexes the workspace (CAN-3799 D11, D12), and raises a typed
 * `WorkspaceCreationRefusedError` with the message the desktop has always
 * shown. W5 files commit together with an optional collection revision check;
 * keyed calls reserve before provisioning and replay their portable outcome.
 * A repeated create without a key still adds another project.
 */
export function createWorkspace(
  request: WorkspaceCreationRequest & { idempotencyKey: string },
  parentCommit?: W5CommitOptions,
): Promise<WorkspaceCreationReceiptOutcome>;
export function createWorkspace(
  request: WorkspaceCreationRequest & { idempotencyKey?: undefined },
  parentCommit?: W5CommitOptions,
): Promise<WorkspaceCreationOutcome>;
export function createWorkspace(
  request: WorkspaceCreationRequest,
  parentCommit?: W5CommitOptions,
): Promise<WorkspaceCreationOutcome | WorkspaceCreationReceiptOutcome>;
export function createWorkspace(
  request: WorkspaceCreationRequest,
  parentCommit?: W5CommitOptions,
): Promise<WorkspaceCreationOutcome | WorkspaceCreationReceiptOutcome> {
  return withStorageAdmission(PROJECT_W5_STORAGE, async () => {
    // Read-only admission retains the old validation and messages.
    await admitCreation(request.variant, request.idempotencyKey === undefined);
    const expectedRevisions: W5CommitOptions['expectedRevisions'] =
      request.expectedRevision === undefined
        ? undefined
        : [
            {
              resource: { kind: 'workspaces' },
              revision: request.expectedRevision,
            },
          ];
    const execute = async (
      binding: W5CommitOptions,
      attempt?: W5KeyedAttempt,
    ): Promise<WorkspaceCreationOutcome> => {
      const outcome = await withWorkspaceCreationCommit(
        parentCommit ?? { ...binding, expectedRevisions },
        () => runCreation(request.variant),
        attempt ? (): void => attempt.beforeEffects() : undefined,
        attempt
          ? (error): void =>
              attempt.validate(() => {
                throw error;
              })
          : undefined,
      );
      const scriptActionsOperationId = await afterWorkspaceCreationCommit(
        afterCommit,
        {
          workspace: outcome.workspace,
          source: request.source,
          addsScriptActions: !isHostDirect(request.variant),
        },
      );
      if (scriptActionsOperationId !== undefined)
        outcome.scriptActionsOperationId = scriptActionsOperationId;
      return outcome;
    };
    if (request.idempotencyKey === undefined)
      return execute({ operation: 'core.workspace.create' });
    const { operation, parameters } = isHostDirect(request.variant)
      ? { operation: 'core.workspace.import', parameters: request.variant }
      : workspaceCreationKeyedRequest(request.variant);
    return runKeyedW5Operation(
      {
        caller: request.receiptCaller ?? `desktop-host:${request.source}`,
        operation,
        idempotencyKey: request.idempotencyKey,
        parameters,
        admit: () => admitCreation(request.variant),
        isPreEffectRefusal: (error) =>
          error instanceof CloneCancelledError ||
          error instanceof WorkspaceCreationRefusedError ||
          error instanceof ImportFolderNotFoundError ||
          error instanceof CoworkWorkspaceRecordRefusedError ||
          error instanceof IdentifierValidationError ||
          // Thrown before anything is written: the key may be sent again.
          error instanceof WorkspaceIdentityInUseError,
      },
      (outcome) => receiptOutcomeSchema.parse(outcome),
      async (binding, attempt) => {
        const result = await execute(binding, attempt);
        const outcome = projectReceiptOutcome(
          result.workspace,
          result.clonedRepoIds,
          result.scriptActionsOperationId,
        );
        // Activation, publication hooks and telemetry may still fail after the
        // canonical publication. Only a fully returned command earns a receipt.
        await withW5Commit({ ...binding, outcome }, async () => {});
        return outcome;
      },
    );
  });
}
