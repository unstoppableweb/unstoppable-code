import {
  composeCanopyInstructionRegistries,
  CORE_WORKSPACE_COMMAND_INSTRUCTION_DEFINITIONS,
  CORE_WORKSPACE_METADATA_INSTRUCTION_DEFINITIONS,
  type CanopyCallerDescriptor,
  type CoreWorkspacePrivateMemoryUpdateResult,
  type CoreWorkspaceRepositoryAddParams,
  type CoreWorkspaceRepositoryAddResult,
  type CoreWorkspaceRepositoryRemoveResult,
  type CoreWorkspaceScriptsChange,
  type CoreWorkspaceUpdateParams,
  type CoreWorkspaceUpdateResult,
} from '@canopy/protocol/canopy-core';
import {
  normalizeWorkspacePlanDetection,
  type WorkspacePlanDetectionConfig,
} from '@canopy/protocol/plan-detection';
import {
  isScriptDefinition,
  type ScriptInputMap,
  type ScriptValue,
} from '@canopy/protocol/scripts';
import { isProjectStartPage } from '@canopy/protocol/start-page';
import type {
  CanopyDispatcherInstructionHandlerMap,
  CanopyHandlerContext,
} from '../../runtime/types';
import {
  WorkspaceMetadataRefusedError,
  type WorkspaceMetadataPatch,
  type WorkspaceStartPageChange,
} from '../w5/workspace-metadata/metadata';
import {
  ScriptHookSettingsRefusedError,
  type WorkspaceScriptsChange,
} from '../w5/workspace-metadata/settings';
import { toCoreWorkspaceMetadataWireError } from './metadata-wire-errors';

/*
 * `core.workspace.*` metadata commands (W7a, CAN-5523): #3 update, #4
 * reorder, #6 scripts, #8 plan detection, #10 private memory, and #13 and
 * #14 repository add and remove, over a host port. Core maps the wire
 * request to the typed W5 command and its failures to the pages' A7 codes;
 * the host runs the W5 command cores (`../w5/workspace-metadata`), derives
 * the caller's source and receipt scope, and resolves addressing before any
 * key is reserved (RR5). Params never carry a source, scope or host path.
 */

/** #3 (web-owned, CAN-4158) and the six W7a-1a definitions. */
export const CORE_WORKSPACE_METADATA_COMMAND_DEFINITIONS =
  composeCanopyInstructionRegistries(
    {
      'core.workspace.update':
        CORE_WORKSPACE_COMMAND_INSTRUCTION_DEFINITIONS['core.workspace.update'],
    },
    CORE_WORKSPACE_METADATA_INSTRUCTION_DEFINITIONS,
  );

type Definitions = typeof CORE_WORKSPACE_METADATA_COMMAND_DEFINITIONS;
export type CoreWorkspaceMetadataCommandName = Extract<
  keyof Definitions,
  string
>;

/** One wire call: the authenticated caller and the request's key. */
export interface CoreWorkspaceMetadataCall {
  readonly caller: CanopyCallerDescriptor;
  readonly idempotencyKey: string;
}

interface Revisioned {
  workspaceId: string;
  /** The workspace revision (`workspace:{id}`), checked when supplied. */
  expectedRevision?: number;
}

export interface CoreWorkspaceMetadataHost {
  /** The result is the workspace as the decision left it (DM-2). */
  update(
    input: Revisioned & { patch: WorkspaceMetadataPatch<string> },
    call: CoreWorkspaceMetadataCall,
  ): Promise<CoreWorkspaceUpdateResult>;
  /** `expectedRevision` is the `workspaces` collection revision. */
  reorder(
    input: {
      visibleWorkspaceIds: readonly string[];
      activeWorkspaceId: string;
      overWorkspaceId: string;
      expectedRevision?: number;
    },
    call: CoreWorkspaceMetadataCall,
  ): Promise<void>;
  updateScripts(
    input: Revisioned & { change: WorkspaceScriptsChange },
    call: CoreWorkspaceMetadataCall,
  ): Promise<void>;
  updatePlanDetection(
    input: Revisioned & { planDetection: WorkspacePlanDetectionConfig },
    call: CoreWorkspaceMetadataCall,
  ): Promise<void>;
  updatePrivateMemory(
    input: Revisioned & { privateMemory: boolean },
    call: CoreWorkspaceMetadataCall,
  ): Promise<CoreWorkspacePrivateMemoryUpdateResult>;
  /** Path-free: the host redeems the selection, or refuses it. */
  addRepository(
    input: Omit<CoreWorkspaceRepositoryAddParams, '_meta'>,
    call: CoreWorkspaceMetadataCall,
  ): Promise<CoreWorkspaceRepositoryAddResult>;
  removeRepository(
    input: Revisioned & { repoId: string },
    call: CoreWorkspaceMetadataCall,
  ): Promise<CoreWorkspaceRepositoryRemoveResult>;
}

export type CoreWorkspaceMetadataHandlers =
  CanopyDispatcherInstructionHandlerMap<Definitions>;

function isScriptValue(value: unknown): value is ScriptValue {
  return (
    value === null || typeof value === 'string' || isScriptDefinition(value)
  );
}

/** The page's script maps as the desktop normalizer reads them. */
function scriptInputMap(
  scripts: Readonly<Record<string, unknown>> | undefined,
): ScriptInputMap | undefined {
  if (scripts === undefined) return undefined;
  const map: ScriptInputMap = {};
  for (const [name, value] of Object.entries(scripts))
    if (isScriptValue(value)) map[name] = value;
  return map;
}

/** The same typed change the W5 qualification port builds (CAN-5522). */
function scriptsChange(
  change: CoreWorkspaceScriptsChange,
): WorkspaceScriptsChange {
  switch (change.kind) {
    case 'replace':
      return { kind: 'replace', scripts: scriptInputMap(change.scripts) };
    case 'merge-commands':
      return { kind: 'merge-commands', commands: change.commands };
    case 'repositories':
      return {
        kind: 'repositories',
        repos: change.repos.map((repo) => ({
          repoId: repo.repoId,
          scripts: scriptInputMap(repo.scripts),
        })),
      };
    case 'definition':
      if (!isScriptValue(change.value))
        throw new ScriptHookSettingsRefusedError(
          'invalid-request',
          'Invalid script.',
        );
      return {
        kind: 'definition',
        ...(change.repoId !== undefined && { repoId: change.repoId }),
        name: change.name,
        value: change.value,
      };
    case 'remove-definition':
      return {
        kind: 'remove-definition',
        ...(change.repoId !== undefined && { repoId: change.repoId }),
        name: change.name,
      };
  }
}

/** `inherit` removes the local override; a page or `null` sets one. */
function startPageChange(
  startPage: CoreWorkspaceUpdateParams['patch']['startPage'],
): WorkspaceStartPageChange | undefined {
  if (startPage === undefined) return undefined;
  if (startPage === null) return { kind: 'set', startPage: null };
  if (startPage.kind === 'inherit') return { kind: 'inherit' };
  if (!isProjectStartPage(startPage))
    throw new WorkspaceMetadataRefusedError(
      'invalid-patch',
      'Invalid start page',
    );
  return { kind: 'set', startPage };
}

function updatePatch(
  patch: CoreWorkspaceUpdateParams['patch'],
): WorkspaceMetadataPatch<string> {
  const { name, color, pinned, collapsed, itemSortMode, alwaysShow } = patch;
  const startPage = startPageChange(patch.startPage);
  return {
    ...(name !== undefined && { name }),
    ...(color !== undefined && { color }),
    ...(pinned !== undefined && { pinned }),
    ...(collapsed !== undefined && { collapsed }),
    ...(itemSortMode !== undefined && { itemSortMode }),
    ...(patch.activitySectionOrder !== undefined && {
      activitySectionOrder: patch.activitySectionOrder,
    }),
    ...(alwaysShow !== undefined && { alwaysShow }),
    ...(startPage !== undefined && { startPage }),
  };
}

function revisioned(
  workspaceId: string,
  expectedRevision: number | undefined,
): Revisioned {
  return {
    workspaceId,
    ...(expectedRevision !== undefined && { expectedRevision }),
  };
}

function call(context: CanopyHandlerContext): CoreWorkspaceMetadataCall {
  const key = context.metadata.idempotencyKey;
  // The dispatcher refuses a keyed instruction without a key first.
  if (!key) throw new Error('An idempotency key is required.');
  return { caller: context.caller, idempotencyKey: key };
}

/** The seven handlers over `host`; register them only where `host` runs. */
export function createCoreWorkspaceMetadataHandlers(
  host: CoreWorkspaceMetadataHost,
): CoreWorkspaceMetadataHandlers {
  const run = async <Result>(
    operation: CoreWorkspaceMetadataCommandName,
    command: () => Promise<Result>,
  ): Promise<Result> => {
    try {
      return await command();
    } catch (error) {
      throw toCoreWorkspaceMetadataWireError(
        CORE_WORKSPACE_METADATA_COMMAND_DEFINITIONS[operation],
        operation,
        error,
      );
    }
  };
  return {
    'core.workspace.update': (params, context) =>
      run('core.workspace.update', () =>
        host.update(
          {
            ...revisioned(params.workspaceId, params.expectedRevision),
            patch: updatePatch(params.patch),
          },
          call(context),
        ),
      ),
    'core.workspace.reorder': (params, context) =>
      run('core.workspace.reorder', async () => {
        await host.reorder(
          {
            visibleWorkspaceIds: params.visibleWorkspaceIds,
            activeWorkspaceId: params.activeWorkspaceId,
            overWorkspaceId: params.overWorkspaceId,
            ...(params.expectedRevision !== undefined && {
              expectedRevision: params.expectedRevision,
            }),
          },
          call(context),
        );
        return { acknowledged: true };
      }),
    'core.workspace.scripts.update': (params, context) =>
      run('core.workspace.scripts.update', async () => {
        await host.updateScripts(
          {
            ...revisioned(params.workspaceId, params.expectedRevision),
            change: scriptsChange(params.change),
          },
          call(context),
        );
        return {};
      }),
    'core.workspace.planDetection.update': (params, context) =>
      run('core.workspace.planDetection.update', async () => {
        await host.updatePlanDetection(
          {
            ...revisioned(params.workspaceId, params.expectedRevision),
            // Stored normalized, as the desktop write stores it.
            planDetection:
              normalizeWorkspacePlanDetection(params.planDetection) ?? {},
          },
          call(context),
        );
        return {};
      }),
    'core.workspace.privateMemory.update': (params, context) =>
      run('core.workspace.privateMemory.update', () =>
        host.updatePrivateMemory(
          {
            ...revisioned(params.workspaceId, params.expectedRevision),
            privateMemory: params.privateMemory,
          },
          call(context),
        ),
      ),
    'core.workspace.repository.add': (params, context) =>
      run('core.workspace.repository.add', () =>
        host.addRepository(
          {
            ...revisioned(params.workspaceId, params.expectedRevision),
            repository: params.repository,
          },
          call(context),
        ),
      ),
    'core.workspace.repository.remove': (params, context) =>
      run('core.workspace.repository.remove', () =>
        host.removeRepository(
          {
            ...revisioned(params.workspaceId, params.expectedRevision),
            repoId: params.repoId,
          },
          call(context),
        ),
      ),
  };
}
