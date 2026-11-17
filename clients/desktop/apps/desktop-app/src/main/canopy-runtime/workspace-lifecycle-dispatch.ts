import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import {
  CORE_WORKSPACE_METADATA_GRANTS,
  CoreArchiveContainerRestoreParamsSchema,
  CoreWorkspaceCreateParamsSchema,
  CoreWorkspaceDeleteParamsSchema,
  CoreWorkspaceImportParamsSchema,
  CoreWorktreeArchiveParamsSchema,
  CoreWorktreeCreateParamsSchema,
  CoreWorktreeDeleteParamsSchema,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '@canopy/core-runtime';
import { redactRemoteUrlCredentials } from '../lib/git-clone-progress';
import type { DesktopCanopyDispatcher } from './desktop-runtime';

/*
 * The IPC projections of the registered lifecycle commands: the creates
 * (W7b-3, CAN-5551) #1 `core.workspace.create`, #2 `core.workspace.import`
 * and #21 `core.worktree.create`, and (W7b-2a, CAN-5550) #24
 * `core.worktree.archive`, #5 `core.workspace.delete` and #28
 * `core.archive.container.restore`, plus #25 `core.worktree.delete`
 * (W7b-2b, CAN-5575). Each dispatches its operation with the
 * write grant added for this call, so the dispatcher's grant check, the Q8
 * caller check and draining apply, and hands the handler the host request
 * today's caller makes in an in-process projection context. The handler runs
 * that request unchanged (its source, its unkeyed `desktop-host:*` decision,
 * its trusted path and lifecycle callbacks), so bytes, results and errors
 * stay as they were; the dispatcher key minted per call never reaches a
 * receipt. The params name the target only: the host request checks no
 * revision, so a required `expectedRevision` is a placeholder no handler
 * reads. A request the wire cannot express keeps its in-process call.
 */

type LifecycleOperation =
  | 'core.workspace.create'
  | 'core.workspace.import'
  | 'core.worktree.create'
  | 'core.worktree.archive'
  | 'core.worktree.delete'
  | 'core.workspace.delete'
  | 'core.archive.container.restore'
  | 'core.workspace.sourceRepo.initialize'
  | 'core.workspace.type.convert'
  | 'core.workspace.sourceChanges.apply'
  | 'core.workspace.composition.promote'
  | 'core.worktree.branch.rename'
  | 'core.sharedContainer.fork';

/** The host request one projected call runs, and how it failed. */
export interface WorkspaceLifecycleProjection {
  readonly run: () => Promise<unknown>;
  failure?: { readonly error: unknown };
}

type ProjectionSlots = Partial<
  Record<LifecycleOperation, WorkspaceLifecycleProjection>
>;

const projections = new AsyncLocalStorage<ProjectionSlots>();

/**
 * The projection the current call carries for `operation`, taken once so a
 * nested call of the same operation runs as a wire call.
 */
export function takeWorkspaceLifecycleProjection(
  operation: LifecycleOperation,
): WorkspaceLifecycleProjection | undefined {
  const slots = projections.getStore();
  const projection = slots?.[operation];
  if (slots) delete slots[operation];
  return projection;
}

/**
 * Ends a projected call once its host request answered: the IPC caller reads
 * the host's own outcome, never the wire result.
 */
export class WorkspaceLifecycleProjectionAnswered extends Error {
  constructor() {
    super('The IPC projection answered from its host request.');
    this.name = 'WorkspaceLifecycleProjectionAnswered';
  }
}

/** Runs a projection's host request, records a failure, and ends the call. */
export async function answerWorkspaceLifecycleProjection(
  projection: WorkspaceLifecycleProjection,
): Promise<never> {
  try {
    await projection.run();
  } catch (error) {
    projection.failure = { error };
    throw error;
  }
  throw new WorkspaceLifecycleProjectionAnswered();
}

function hostError(error: unknown): unknown {
  return error instanceof CanopyOperationError &&
    error.runtimeCause instanceof Error
    ? error.runtimeCause
    : error;
}

export interface WorkspaceLifecycleProjectionTarget {
  dispatcher: Pick<DesktopCanopyDispatcher, 'instruction'>;
  caller: CanopyCallerDescriptor;
}

type LifecycleGrant =
  | 'core.workspace.write'
  | 'core.worktree.write'
  | 'core.archive.write';

/** The operation's write grant, for this call only. */
function withGrant(
  caller: CanopyCallerDescriptor,
  grant: LifecycleGrant,
): CanopyCallerDescriptor {
  return { ...caller, grants: [grant] };
}

/** The archive channels' fields that decide archive versus Delete. */
export interface ProjectedArchiveRequest {
  workspaceId: string;
  worktreeId: string;
  lockAfterArchive?: boolean;
  deleteWithoutRetentionIfMissing?: boolean;
}

export interface ProjectedWorkspaceLifecycleCommands {
  /** #1 for the renderer's new single- or multi-repository project. */
  createWorkspace<T>(
    request: { name: string; workspaceKind: 'single_repo' | 'multi_repo' },
    run: () => Promise<T>,
  ): Promise<T>;
  /** #2 for an existing folder, named by this call's own selection (D8). */
  importFolder<T>(folderPath: string, run: () => Promise<T>): Promise<T>;
  /** #2 for a remote clone into the destination the renderer chose. */
  importRemote<T>(
    request: { remoteUrl: string; name: string },
    run: () => Promise<T>,
  ): Promise<T>;
  /** #21 for the renderer's single- and multi-repository creates. */
  createWorktree<T>(
    request: {
      workspaceId: string;
      branchName?: string;
      existingBranch?: string;
      suggestedBranch?: string;
      baseBranch?: string;
      baseWorktreeId?: string;
      sidebarItemGroupId?: string;
      /** A client-claimed worktree id; the result's id is authoritative. */
      worktreeId?: string;
    },
    run: () => Promise<T>,
  ): Promise<T>;
  /**
   * #24 for an archive that keeps a locked container; #25 for the Delete
   * button's unlocked or missing-checkout request (P-1(i)).
   */
  archiveWorktree<T>(
    request: ProjectedArchiveRequest,
    run: () => Promise<T>,
  ): Promise<T>;
  /** #5 for a renderer deletion of a whole workspace. */
  deleteWorkspace<T>(
    request: { workspaceId: string },
    run: () => Promise<T>,
  ): Promise<T>;
  /** #28 for the archive panel's restore into the archive's own project. */
  restoreArchive<T>(
    request: { workspaceId: string; containerId: string },
    run: () => Promise<T>,
  ): Promise<T>;
}

/**
 * Once the host request settled, it is the answer: its outcome, or its own
 * error whatever the wire mapping made of it. A refusal before the handler
 * (grant, caller, draining) is the dispatcher's.
 */
export async function projectWorkspaceLifecycleCommand<T>(
  operation: LifecycleOperation,
  dispatch: () => Promise<unknown>,
  run: () => Promise<T>,
): Promise<T> {
  let answered: { readonly value: T } | undefined;
  const projection: WorkspaceLifecycleProjection = {
    run: async () => {
      const value = await run();
      answered = { value };
    },
  };
  try {
    await projections.run({ [operation]: projection }, dispatch);
  } catch (error) {
    if (answered) return answered.value;
    if (projection.failure) throw projection.failure.error;
    throw hostError(error);
  }
  throw new Error('The workspace lifecycle projection did not answer.');
}

interface DispatchOptions {
  caller: CanopyCallerDescriptor;
  metadata?: { idempotencyKey: string };
}

/** The desktop lifecycle commands, each projected through its registered operation. */
export function projectedWorkspaceLifecycleCommands(
  target: WorkspaceLifecycleProjectionTarget,
): ProjectedWorkspaceLifecycleCommands {
  const { dispatcher } = target;
  const options = (
    grant: LifecycleGrant,
    idempotencyKey: string,
  ): DispatchOptions => ({
    caller: withGrant(target.caller, grant),
    metadata: { idempotencyKey },
  });
  return {
    createWorkspace(request, run) {
      const idempotencyKey = randomUUID();
      const params = CoreWorkspaceCreateParamsSchema.safeParse({
        name: request.name,
        source: { kind: 'empty', workspaceKind: request.workspaceKind },
        temporary: false,
        _meta: { idempotencyKey },
      });
      if (!params.success) return run();
      return projectWorkspaceLifecycleCommand(
        'core.workspace.create',
        () =>
          dispatcher.instruction(
            'core.workspace.create',
            params.data,
            options(CORE_WORKSPACE_METADATA_GRANTS.write, idempotencyKey),
          ),
        run,
      );
    },
    importFolder(folderPath, run) {
      const idempotencyKey = randomUUID();
      // The projection's own selection of its trusted folder (D8): only this
      // call's context redeems it.
      const params = CoreWorkspaceImportParamsSchema.safeParse({
        source: { kind: 'local_picker_selection', selectionId: randomUUID() },
        name: basename(folderPath),
        _meta: { idempotencyKey },
      });
      if (!params.success) return run();
      return projectWorkspaceLifecycleCommand(
        'core.workspace.import',
        () =>
          dispatcher.instruction(
            'core.workspace.import',
            params.data,
            options(CORE_WORKSPACE_METADATA_GRANTS.write, idempotencyKey),
          ),
        run,
      );
    },
    importRemote(request, run) {
      const idempotencyKey = randomUUID();
      // The host runs the trusted request, so the wire copy never needs the
      // URL's credentials.
      const params = CoreWorkspaceImportParamsSchema.safeParse({
        source: {
          kind: 'git_url',
          value: redactRemoteUrlCredentials(request.remoteUrl),
        },
        name: request.name,
        _meta: { idempotencyKey },
      });
      if (!params.success) return run();
      return projectWorkspaceLifecycleCommand(
        'core.workspace.import',
        () =>
          dispatcher.instruction(
            'core.workspace.import',
            params.data,
            options(CORE_WORKSPACE_METADATA_GRANTS.write, idempotencyKey),
          ),
        run,
      );
    },
    createWorktree(request, run) {
      const idempotencyKey = randomUUID();
      const {
        workspaceId,
        branchName,
        existingBranch,
        suggestedBranch,
        baseBranch,
        baseWorktreeId,
        sidebarItemGroupId,
        worktreeId,
      } = request;
      const params = CoreWorktreeCreateParamsSchema.safeParse({
        workspaceId,
        ...(branchName !== undefined && { branch: branchName }),
        ...(existingBranch !== undefined && { existingBranch }),
        ...(suggestedBranch !== undefined && { suggestedBranch }),
        ...(baseBranch !== undefined && { baseBranch }),
        ...(baseWorktreeId !== undefined && { baseWorktreeId }),
        ...(sidebarItemGroupId !== undefined && { sidebarItemGroupId }),
        ...(worktreeId !== undefined && { worktreeId }),
        _meta: { idempotencyKey },
      });
      if (!params.success) return run();
      return projectWorkspaceLifecycleCommand(
        'core.worktree.create',
        () =>
          dispatcher.instruction(
            'core.worktree.create',
            params.data,
            options('core.worktree.write', idempotencyKey),
          ),
        run,
      );
    },
    archiveWorktree(request, run) {
      if (
        request.lockAfterArchive !== true ||
        request.deleteWithoutRetentionIfMissing === true
      ) {
        const idempotencyKey = randomUUID();
        const params = CoreWorktreeDeleteParamsSchema.safeParse({
          scope: { workspaceId: request.workspaceId },
          worktreeId: request.worktreeId,
          expectedRevision: 0,
          _meta: { idempotencyKey },
        });
        if (!params.success) return run();
        return projectWorkspaceLifecycleCommand(
          'core.worktree.delete',
          () =>
            dispatcher.instruction(
              'core.worktree.delete',
              params.data,
              options('core.worktree.write', idempotencyKey),
            ),
          run,
        );
      }
      // The inherent archive carries no key.
      const params = CoreWorktreeArchiveParamsSchema.safeParse({
        scope: { workspaceId: request.workspaceId },
        worktreeId: request.worktreeId,
        expectedRevision: 0,
        archived: true,
      });
      if (!params.success) return run();
      return projectWorkspaceLifecycleCommand(
        'core.worktree.archive',
        () =>
          dispatcher.instruction('core.worktree.archive', params.data, {
            caller: withGrant(target.caller, 'core.worktree.write'),
          }),
        run,
      );
    },
    deleteWorkspace(request, run) {
      const idempotencyKey = randomUUID();
      const params = CoreWorkspaceDeleteParamsSchema.safeParse({
        workspaceId: request.workspaceId,
        expectedRevision: 0,
        _meta: { idempotencyKey },
      });
      if (!params.success) return run();
      return projectWorkspaceLifecycleCommand(
        'core.workspace.delete',
        () =>
          dispatcher.instruction(
            'core.workspace.delete',
            params.data,
            options(CORE_WORKSPACE_METADATA_GRANTS.write, idempotencyKey),
          ),
        run,
      );
    },
    restoreArchive(request, run) {
      const idempotencyKey = randomUUID();
      const params = CoreArchiveContainerRestoreParamsSchema.safeParse({
        archiveId: request.containerId,
        expectedRevision: 0,
        destinationScope: { workspaceId: request.workspaceId },
        conflictPolicy: 'fail',
        _meta: { idempotencyKey },
      });
      if (!params.success) return run();
      return projectWorkspaceLifecycleCommand(
        'core.archive.container.restore',
        () =>
          dispatcher.instruction(
            'core.archive.container.restore',
            params.data,
            options('core.archive.write', idempotencyKey),
          ),
        run,
      );
    },
  };
}
