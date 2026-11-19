import type {
  CanopyCallerDescriptor,
  CoreScriptDefinitionGetResult,
  CoreScriptDefinitionListResult,
  CoreScriptTarget,
} from '@canopy/protocol/canopy-core';
import { CORE_SCRIPT_GRANTS } from '@canopy/protocol/canopy-core';
import {
  getScriptDisplayName,
  normalizeScriptName,
} from '@canopy/desktop-shared/scripts';
import type {
  ScriptSourceInfoRequest,
  ScriptSourceInfoResponse,
} from '@canopy/desktop-shared/types';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { preserveRuntimeCauseError } from '../canopy-runtime/runtime-cause-error';
import { RemoteControlServiceError } from '../services/remote-control-service-error';
import { toScriptSourceLayer } from './script-resolver';
import { validateId } from './validation';
import { ScriptHookSettingsRefusedError } from '@canopy/core-runtime/node/w5/workspace-metadata/settings';

/*
 * Compatibility projections of the script settings reads over
 * `core.script.definition.*` (CAN-4153). Requests are validated as before, so
 * malformed input keeps its legacy error, and a runtime failure rethrows its
 * original cause, so callers see the same messages.
 */

type ScriptDefinitionDispatcher = Pick<DesktopCanopyDispatcher, 'query'>;

function reading(caller: CanopyCallerDescriptor): {
  caller: CanopyCallerDescriptor;
} {
  return { caller: { ...caller, grants: [CORE_SCRIPT_GRANTS.read] } };
}

/** The portable target and script name of a legacy source-info request. */
export function scriptSourceInfoTarget(request: ScriptSourceInfoRequest): {
  name: string;
  target: CoreScriptTarget;
} {
  const name = normalizeScriptName(request.scriptName);
  if (!name) {
    throw new RemoteControlServiceError(
      'invalid_payload',
      'scriptName is required.',
    );
  }
  const worktree = request.worktreeId ? { worktreeId: request.worktreeId } : {};
  if (request.target === 'project') {
    validateId(request.projectId, 'projectId');
    return {
      name,
      target: { kind: 'project', workspaceId: request.projectId, ...worktree },
    };
  }
  validateId(request.workspaceId, 'workspaceId');
  if (request.target === 'workspace-root') {
    return {
      name,
      target: {
        kind: 'workspace-root',
        workspaceId: request.workspaceId,
        ...worktree,
      },
    };
  }
  validateId(request.repoId, 'repoId');
  return {
    name,
    target: {
      kind: 'workspace-repo',
      workspaceId: request.workspaceId,
      repoId: request.repoId,
      ...worktree,
    },
  };
}

export function toScriptSourceInfoResponse(
  result: Pick<
    CoreScriptDefinitionGetResult,
    'name' | 'layers' | 'effectiveCommand'
  >,
): ScriptSourceInfoResponse {
  return {
    scriptName: result.name,
    scriptDisplayName: getScriptDisplayName(result.name),
    layers: result.layers.map(toScriptSourceLayer),
    effectiveCommand: result.effectiveCommand,
  };
}

/** `script:source-info` and `portal.script.source_info`. */
export async function readScriptSourceInfo(
  dispatcher: ScriptDefinitionDispatcher,
  caller: CanopyCallerDescriptor,
  request: ScriptSourceInfoRequest,
): Promise<ScriptSourceInfoResponse> {
  const { name, target } = scriptSourceInfoTarget(request);
  return toScriptSourceInfoResponse(
    await preserveRuntimeCauseError(
      dispatcher.query(
        'core.script.definition.get',
        { target, name },
        reading(caller),
      ),
    ),
  );
}

/** Each enabled script's command, by name. */
export function toScriptCommands(
  result: CoreScriptDefinitionListResult,
): Record<string, string> {
  const commands: Record<string, string> = {};
  for (const definition of result.definitions) {
    if (definition.state === 'enabled') {
      commands[definition.name] = definition.command;
    }
  }
  return commands;
}

/**
 * `workspace:read-scripts` and `portal.workspace.scripts.get`: the commands of
 * a workspace's own top-level script settings, which are the project's own
 * settings in a single-repository workspace.
 */
export async function readWorkspaceScriptCommands(
  dispatcher: ScriptDefinitionDispatcher,
  caller: CanopyCallerDescriptor,
  workspaceId: string,
): Promise<Record<string, string>> {
  validateId(workspaceId, 'workspaceId');
  try {
    return toScriptCommands(
      await preserveRuntimeCauseError(
        dispatcher.query(
          'core.script.definition.list',
          { target: { kind: 'workspace-root', workspaceId }, layer: 'local' },
          reading(caller),
        ),
      ),
    );
  } catch (error) {
    // These reads always answered an absent or unreadable manifest with no
    // scripts.
    if (
      error instanceof ScriptHookSettingsRefusedError &&
      error.reason === 'configuration-unavailable'
    )
      return {};
    throw error;
  }
}
