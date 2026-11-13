import {
  composeCanopyInstructionRegistries,
  CORE_GUARDED_SETTINGS_INSTRUCTION_DEFINITIONS,
  CORE_WORKSPACE_COMMAND_INSTRUCTION_DEFINITIONS,
  type CanopyWorkspaceScope,
  type CoreWorkspaceCoworkUpdateParams,
  type CoreWorkspaceCoworkUpdateResult,
  type CoreWorkspaceHooksUpdateParams,
  type CoreWorkspacePluginsUpdateParams,
  type CoreWorkspacePluginsUpdateResult,
  type CoreWorkspaceRetentionUpdateParams,
  type CoreWorkspaceRetentionUpdateResult,
  type CoreWorktreeCommandResult,
  type CoreWorktreeHooksSetPausedParams,
  type CoreWorktreeHooksSetPausedResult,
  type CoreWorktreeReorderParams,
  type CoreWorktreeUpdateParams,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../runtime/errors';
import type {
  CanopyDispatcherInstructionHandlerMap,
  CanopyHandlerContext,
} from '../../runtime/types';
import type { CoreWorkspaceMetadataCall } from './metadata-commands';
import { toCoreGuardedWireError } from './guarded-wire-errors';

/*
 * The guarded W5 commands registered by W7b-1b (CAN-5549): #7
 * `core.workspace.hooks.update`, #11 `.retention.update`, #22
 * `core.worktree.update`, #23 `.reorder` (move only) and #26
 * `.hooks.setPaused`; and by W7b-1c (CAN-5568): #9 `.plugins.update` and
 * #12 `.cowork.update` (A28′(a)), over a host port. Core maps the wire
 * request to the typed command and its failures to the pages' A7 codes; the
 * host runs the W5d2 boundaries, which stay Electron boundaries (M-1(a)),
 * derives the caller's source and receipt scope, and resolves addressing.
 * Params never carry a source, a receipt scope or a host path.
 */

const GUARDED = CORE_GUARDED_SETTINGS_INSTRUCTION_DEFINITIONS;

/** The seven definitions, each its registry's own object (#22 is web-owned). */
export const CORE_WORKSPACE_GUARDED_COMMAND_DEFINITIONS =
  composeCanopyInstructionRegistries(
    {
      'core.workspace.hooks.update': GUARDED['core.workspace.hooks.update'],
      'core.workspace.plugins.update': GUARDED['core.workspace.plugins.update'],
      'core.workspace.cowork.update': GUARDED['core.workspace.cowork.update'],
      'core.workspace.retention.update':
        GUARDED['core.workspace.retention.update'],
      'core.worktree.hooks.setPaused': GUARDED['core.worktree.hooks.setPaused'],
      'core.worktree.reorder': GUARDED['core.worktree.reorder'],
    },
    {
      'core.worktree.update':
        CORE_WORKSPACE_COMMAND_INSTRUCTION_DEFINITIONS['core.worktree.update'],
    },
  );

type Definitions = typeof CORE_WORKSPACE_GUARDED_COMMAND_DEFINITIONS;
export type CoreWorkspaceGuardedCommandName = Extract<
  keyof Definitions,
  string
>;

/** One wire call: the authenticated caller and the request's key. */
export type CoreWorkspaceGuardedCall = CoreWorkspaceMetadataCall;

/** #22's patch once `targetId` is resolved: the boundary's own fields. */
export type CoreWorktreeMetadataPatch = Omit<
  CoreWorktreeUpdateParams['patch'],
  'targetId'
>;

export interface CoreWorkspaceGuardedHost {
  /** `expectedRevision` is the workspace revision (`workspace:{id}`). */
  updateHooks(
    input: Omit<CoreWorkspaceHooksUpdateParams, '_meta'>,
    call: CoreWorkspaceGuardedCall,
  ): Promise<void>;
  /** `expectedRevision` is the workspace revision (`workspace:{id}`). */
  updatePlugins(
    input: Omit<CoreWorkspacePluginsUpdateParams, '_meta'>,
    call: CoreWorkspaceGuardedCall,
  ): Promise<CoreWorkspacePluginsUpdateResult>;
  updateRetention(
    input: Omit<CoreWorkspaceRetentionUpdateParams, '_meta'>,
    call: CoreWorkspaceGuardedCall,
  ): Promise<CoreWorkspaceRetentionUpdateResult>;
  /** `expectedRevision` is the workspace revision (`workspace:{id}`). */
  updateCoworkSettings(
    input: Omit<CoreWorkspaceCoworkUpdateParams, '_meta'>,
    call: CoreWorkspaceGuardedCall,
  ): Promise<CoreWorkspaceCoworkUpdateResult>;
  /**
   * The host resolves `scope` as `core.worktree.get` does; `expectedRevision`
   * is the row revision (`worktree:{ws}/{wt}`). The result is the saved
   * outcome's row, as the desktop read projects it (D-2).
   */
  updateWorktree(
    input: {
      scope?: CanopyWorkspaceScope;
      worktreeId: string;
      expectedRevision: number;
      patch: CoreWorktreeMetadataPatch;
    },
    call: CoreWorkspaceGuardedCall,
  ): Promise<CoreWorktreeCommandResult>;
  /** `expectedRevision` is the `worktrees:{workspaceId}` collection's. */
  reorderWorktree(
    input: Omit<CoreWorktreeReorderParams, '_meta'>,
    call: CoreWorkspaceGuardedCall,
  ): Promise<void>;
  /** `expectedRevision` is the row revision (`worktree:{ws}/{wt}`). */
  setWorktreeHooksPaused(
    input: Omit<CoreWorktreeHooksSetPausedParams, '_meta'>,
    call: CoreWorkspaceGuardedCall,
  ): Promise<CoreWorktreeHooksSetPausedResult>;
}

export type CoreWorkspaceGuardedHandlers =
  CanopyDispatcherInstructionHandlerMap<Definitions>;

/**
 * A5: a non-null `targetId` asks for routing this host cannot do, so it is
 * refused before the boundary and no key is used; a null one is dropped.
 */
function worktreePatch(
  patch: CoreWorktreeUpdateParams['patch'],
): CoreWorktreeMetadataPatch {
  const { targetId, ...fields } = patch;
  if (targetId !== undefined && targetId !== null)
    throw new CanopyOperationError({
      kind: 'capability_unavailable',
      message: "This host can't route a worktree to an execution target.",
      details: { reason: 'target-unavailable' },
      retry: { kind: 'never' },
    });
  if (Object.keys(fields).length === 0)
    throw new CanopyOperationError({
      kind: 'invalid_argument',
      message: 'Patch is empty.',
      retry: { kind: 'never' },
    });
  return fields;
}

function revisioned(expectedRevision: number | undefined): {
  expectedRevision?: number;
} {
  return expectedRevision === undefined ? {} : { expectedRevision };
}

function call(context: CanopyHandlerContext): CoreWorkspaceGuardedCall {
  const key = context.metadata.idempotencyKey;
  // The dispatcher refuses a keyed instruction without a key first.
  if (!key) throw new Error('An idempotency key is required.');
  return { caller: context.caller, idempotencyKey: key };
}

/** The seven handlers over `host`; register them only where `host` runs. */
export function createCoreWorkspaceGuardedHandlers(
  host: CoreWorkspaceGuardedHost,
): CoreWorkspaceGuardedHandlers {
  const run = async <Result>(
    operation: CoreWorkspaceGuardedCommandName,
    command: () => Promise<Result>,
  ): Promise<Result> => {
    try {
      return await command();
    } catch (error) {
      throw toCoreGuardedWireError(
        CORE_WORKSPACE_GUARDED_COMMAND_DEFINITIONS[operation],
        operation,
        error,
      );
    }
  };
  return {
    'core.workspace.hooks.update': (params, context) =>
      run('core.workspace.hooks.update', async () => {
        await host.updateHooks(
          {
            workspaceId: params.workspaceId,
            ...revisioned(params.expectedRevision),
            change: params.change,
          },
          call(context),
        );
        return {};
      }),
    'core.workspace.plugins.update': (params, context) =>
      run('core.workspace.plugins.update', () =>
        host.updatePlugins(
          {
            workspaceId: params.workspaceId,
            ...revisioned(params.expectedRevision),
            change: params.change,
          },
          call(context),
        ),
      ),
    'core.workspace.cowork.update': (params, context) =>
      run('core.workspace.cowork.update', () =>
        host.updateCoworkSettings(
          {
            workspaceId: params.workspaceId,
            ...revisioned(params.expectedRevision),
            settings: params.settings,
          },
          call(context),
        ),
      ),
    'core.workspace.retention.update': (params, context) =>
      run('core.workspace.retention.update', () =>
        host.updateRetention(
          {
            workspaceId: params.workspaceId,
            ...revisioned(params.expectedRevision),
            patch: params.patch,
          },
          call(context),
        ),
      ),
    'core.worktree.update': (params, context) =>
      run('core.worktree.update', () => {
        const patch = worktreePatch(params.patch);
        return host.updateWorktree(
          {
            ...(params.scope !== undefined && { scope: params.scope }),
            worktreeId: params.worktreeId,
            expectedRevision: params.expectedRevision,
            patch,
          },
          call(context),
        );
      }),
    'core.worktree.reorder': (params, context) =>
      run('core.worktree.reorder', async () => {
        await host.reorderWorktree(
          {
            workspaceId: params.workspaceId,
            activeWorktreeId: params.activeWorktreeId,
            overWorktreeId: params.overWorktreeId,
            ...revisioned(params.expectedRevision),
          },
          call(context),
        );
        return {};
      }),
    'core.worktree.hooks.setPaused': (params, context) =>
      run('core.worktree.hooks.setPaused', () =>
        host.setWorktreeHooksPaused(
          {
            workspaceId: params.workspaceId,
            worktreeId: params.worktreeId,
            ...revisioned(params.expectedRevision),
            change: params.change,
          },
          call(context),
        ),
      ),
  };
}
