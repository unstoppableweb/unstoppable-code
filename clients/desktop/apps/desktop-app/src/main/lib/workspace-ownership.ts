import { withW5RepositoryLocks } from './w5-repository-locks';
import { getWorkspaceConfigPath, getWorkspaceIndexFilePath } from './paths';
import { serializeWorkspaceMutation } from './chat-project-operation-queue';
import type { HookOverrides } from '@canopy/desktop-shared/hooks';
import type { WorkspaceOwnerBinding } from '@canopy/desktop-shared/types';
import {
  getWorkspaceIndexRepository,
  readWorkspaceIndexEntries,
} from './sidebar-items';
import {
  WORKSPACE_INDEX_STORAGE,
  WORKSPACE_MANIFEST_STORAGE,
  withStorageAdmission,
} from './w5-storage';
import {
  readWorkspaceConfigDetailed,
  WorkspaceConfigUnreadableError,
  type WorkspaceOwnership,
  type WorkspaceOwnershipRead,
  type WorkspaceOwnershipUpdate,
} from './workspace-persistence';
import {
  applyAdoptedWorkspaceRelease,
  applyPersonalCatalogIdDecision,
  applyWorkspaceCloudBindingDecision,
  applyWorkspaceOwnerDecision,
  applyWorkspaceOwnershipDecision,
} from './workspace-ownership-decision-port';
import type { WorkspaceCloudBindingCompare } from './worktree-record-decisions';

// `internal.workspace.ownership.record` (CAN-3799 D9, CAN-3819): the host
// records a workspace's ownership metadata from trusted inputs (an
// organization claim, the personal catalog enrollment, a hook resolution or
// an owner change), never from client parameters. Each function below is one
// part of the command, with a closed caller source. None takes a client
// revision; each keeps the guard of the writer it replaced, and the ids it
// takes come from the host's own records, as before. Each builds a decision
// and applies it through the record decision port (W5c2). The organization
// private memory part is `recordOrganizationPrivateMemory` (CAN-3817).

export type WorkspaceOwnershipRecordRefusal = 'binding-mismatch';

/** An ownership record was refused before anything was written. */
export class WorkspaceOwnershipRecordRefusedError extends Error {
  constructor(
    readonly reason: WorkspaceOwnershipRecordRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceOwnershipRecordRefusedError';
  }
}

const BINDING_MISMATCH_MESSAGE =
  'Existing workspace has a different organization binding';

/** The caller of an organization owner binding change. */
export type WorkspaceOwnerRecordSource =
  /**
   * The organization project materialization: conversion to an organization
   * project, adoption, move back to Personal and their setup journal sweep
   * (`org-projects:*`).
   */
  'org_project_materialization' | 'organization_access_loss';

export interface WorkspaceOwnerRecord {
  workspaceId: string;
  source: WorkspaceOwnerRecordSource;
  /**
   * Decides the replacement ownership from the authoritative current one, or
   * `null` to leave the workspace as it is.
   */
  update: (
    current: Extract<WorkspaceOwnershipRead, { authority: 'ok' }>,
  ) => WorkspaceOwnership | null;
}

/**
 * Replaces a workspace's owner binding and ownership transfer (CAN-3415): the
 * explicit privileged ownership write. The caller's decision and the write
 * use one read inside the workspace's manifest write queue; every other field
 * is kept. A missing workspace is `absent`, and an unreadable manifest or
 * owner is `unreadable` and left as it is.
 */
export function recordWorkspaceOwner(
  record: WorkspaceOwnerRecord,
): Promise<WorkspaceOwnershipUpdate> {
  return applyWorkspaceOwnerDecision(record.workspaceId, (current) => {
    const next = record.update(current);
    return (
      next && {
        kind: 'ownership.owner',
        owner: next.owner,
        ownershipTransfer: next.ownershipTransfer,
        ...(Object.prototype.hasOwnProperty.call(next, 'detachedOwner')
          ? { detachedOwner: next.detachedOwner }
          : {}),
      }
    );
  });
}

export interface OrganizationOwnerRefresh {
  workspaceId: string;
  /** A re-claim of the same instance after its lease expired. */
  source: 'org_project_reclaim';
  owner: Extract<WorkspaceOwnerBinding, { type: 'organization' }>;
}

/**
 * Moves the fence of an organization binding forward on a re-claim of the
 * same organization, project and instance, and resolves the binding the
 * workspace now holds. The fence only advances: a lower generation is a
 * stale caller, and the binding is left as it is. A workspace whose manifest
 * is missing, unreadable or bound to anything else is refused with
 * `binding-mismatch` and left as it is.
 */
export async function refreshOrganizationOwner(
  refresh: OrganizationOwnerRefresh,
): Promise<Extract<WorkspaceOwnerBinding, { type: 'organization' }>> {
  const { status, held } = await applyWorkspaceOwnerDecision(
    refresh.workspaceId,
    { kind: 'ownership.organization.refresh', owner: refresh.owner },
  );
  if (!held || (status !== 'written' && status !== 'declined')) {
    throw new WorkspaceOwnershipRecordRefusedError(
      'binding-mismatch',
      BINDING_MISMATCH_MESSAGE,
    );
  }
  return held;
}

export interface PersonalCatalogIdRecord {
  workspaceId: string;
  /**
   * The personal workspace catalog sync enrolling a workspace, or the cloud
   * project binding using the id as the project's creation key (CAN-5190).
   */
  source: 'personal_catalog_sync' | 'cloud_project_binding';
  /** Asked inside the write queue; enrollment stops when it says no. */
  allowed: () => Promise<boolean>;
}

/**
 * Enrolls a Personal workspace in the personal catalog: while `allowed` still
 * says yes inside the write queue, resolves its `personalCatalogId`,
 * allocating one when it has none. Otherwise, and for an organization,
 * temporary, missing or unreadable workspace, it resolves `undefined` and
 * leaves the workspace as it is.
 */
export function recordPersonalCatalogId(
  record: PersonalCatalogIdRecord,
): Promise<string | undefined> {
  return applyPersonalCatalogIdDecision(
    record.workspaceId,
    { kind: 'ownership.personal-catalog-id' },
    record.allowed,
  );
}

export interface WorkspaceCloudBindingRecord {
  workspaceId: string;
  /** The cloud project binding (CAN-5190): its reconcile, link and lifecycle. */
  source: 'cloud_project_binding';
  update: WorkspaceCloudBindingCompare;
}

/**
 * Records a workspace's cloud project identity (CAN-5190): the caller's
 * decision and the write use one read inside the manifest write queue, and
 * only `cloudBinding` changes. A missing workspace is `absent`; an unreadable
 * manifest or owner is `unreadable` and left as it is.
 */
export function recordWorkspaceCloudBinding(
  record: WorkspaceCloudBindingRecord,
): Promise<WorkspaceOwnershipUpdate> {
  return applyWorkspaceCloudBindingDecision(record.workspaceId, record.update);
}

export interface OrganizationHookBindingsRecord {
  workspaceId: string;
  /** The repository whose local hooks are bound; the workspace root when omitted. */
  repoId?: string;
  /** Hook resolution, which binds inherited organization hooks on read. */
  source: 'hook_resolution';
  /** The hooks the source configuration provides. */
  sourceHooks: HookOverrides | undefined;
  /** The local hooks the caller read. */
  localHooks: HookOverrides | undefined;
  owner: WorkspaceOwnerBinding | undefined;
}

/**
 * Binds inherited organization hooks to the workspace's organization in its
 * local hooks, when the organization projects flag is on. The binding uses
 * the owner read inside the manifest write queue, and resolves the hooks and
 * owner it was decided under, so overlay filtering cannot disagree with a
 * concurrent ownership change. A workspace without a readable owner, or a
 * repository it no longer has, is left as it is.
 */
export async function recordOrganizationHookBindings(
  record: OrganizationHookBindingsRecord,
): Promise<{
  hooks: HookOverrides | undefined;
  owner: WorkspaceOwnerBinding | undefined;
}> {
  return applyWorkspaceOwnershipDecision(record.workspaceId, {
    kind: 'ownership.hook-bindings',
    ...(record.repoId === undefined ? {} : { repoId: record.repoId }),
    sourceHooks: record.sourceHooks,
    localHooks: record.localHooks,
    owner: record.owner,
  });
}

export interface HookExecutionContextRebind {
  workspaceId: string;
  /** The background execution rebinder, after the workspace changed owner. */
  source: 'background_execution_rebinding';
  previousContext: string;
  nextContext: string;
}

/**
 * Rebinds the workspace's machine-local chat and pipeline hook actions (and
 * binding-only overlays) from the previous execution context to the next,
 * after the workspace changed owner. Runs inside the manifest write queue so
 * a concurrent hook save is never lost, and writes only when something was
 * rebound, so a missing workspace stays missing. An unreadable manifest is
 * refused rather than replaced (CAN-3563); the rejection lets the rebinder
 * retry later. Resolves the ids of the rebound hooks.
 */
export async function rebindWorkspaceHookExecutionContexts(
  rebind: HookExecutionContextRebind,
): Promise<string[]> {
  return applyWorkspaceOwnershipDecision(rebind.workspaceId, {
    kind: 'ownership.hook-contexts.rebind',
    previousContext: rebind.previousContext,
    nextContext: rebind.nextContext,
  });
}

export interface AdoptedWorkspaceRelease {
  workspaceId: string;
  /** The organization project setup undoing an adoption it did not complete. */
  source: 'org_project_adoption_rollback';
  /** The claim instance the adoption bound the workspace to. */
  instanceId: string;
}

/**
 * Removes an adopted workspace's index entry while the workspace is still
 * bound to this claim instance, and resolves whether the adoption is undone.
 * The binding is checked on the manifest read inside its write queue, and
 * only that index entry is removed, so another workspace created or changed
 * in the meantime is kept (F8). The workspace's files stay, as before. A
 * workspace that is not indexed, or whose manifest is missing or unreadable,
 * is left as it is and counts as undone, as before; one bound to anything
 * else, or whose owner cannot be read, is left as it is and is not undone.
 */
export function releaseAdoptedWorkspace(
  ...args: Parameters<typeof releaseAdmittedAdoptedWorkspace>
): Promise<boolean> {
  // Admitted for both: the manifest check and the index removal are one step.
  return withStorageAdmission(
    [WORKSPACE_INDEX_STORAGE, WORKSPACE_MANIFEST_STORAGE],
    () => releaseAdmittedAdoptedWorkspace(...args),
  );
}

async function releaseAdmittedAdoptedWorkspace(
  release: AdoptedWorkspaceRelease,
): Promise<boolean> {
  return serializeWorkspaceMutation(async (): Promise<boolean> => {
    const { workspaceId, instanceId } = release;
    const indexRepository = getWorkspaceIndexRepository();
    const isIndexed = async (): Promise<boolean> =>
      (await indexRepository.read()).entries.some(
        (entry) => entry.id === workspaceId,
      );
    // An unreadable manifest is left alone without entering its write queue,
    // which would report a refused write.
    if (
      !(await isIndexed()) ||
      (await readWorkspaceConfigDetailed(workspaceId)).authority ===
        'unreadable'
    )
      return true;
    const decided = { released: true };
    await withW5RepositoryLocks(
      [
        { kind: 'index', path: getWorkspaceIndexFilePath() },
        { kind: 'manifest', path: getWorkspaceConfigPath(workspaceId) },
      ],
      async (): Promise<void> => {
        try {
          decided.released = await applyAdoptedWorkspaceRelease(workspaceId, {
            kind: 'ownership.adoption.release',
            instanceId,
            index: { kind: 'ownership.adoption.release.index', workspaceId },
          });
        } catch (error) {
          if (!(error instanceof WorkspaceConfigUnreadableError)) throw error;
        }
      },
    );
    // Keep the workspace type registry in step with the index.
    if (decided.released) await readWorkspaceIndexEntries();
    return decided.released;
  });
}
