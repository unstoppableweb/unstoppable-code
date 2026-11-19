import type {
  CanopyCallerDescriptor,
  CoreScriptErrorCode,
  CoreScriptTarget,
} from '@canopy/protocol/canopy-core';
import type { SingleRepoSidebarItem } from '@canopy/desktop-shared/types';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import type { CoreScriptDefinitionsHost } from '@canopy/core-runtime/node/script/core-script-definitions';
import { RemoteControlServiceError } from '../services/remote-control-service-error';
import {
  getWorktreeDir,
  getWorkspaceWorktreeRepoDir,
  getWorkspaceWorktreeRootRepoDir,
} from './paths';
import {
  collectProjectScriptSourceLayers,
  collectWorkspaceRepoScriptSourceLayers,
  collectWorkspaceRootScriptSourceLayers,
  resolveProjectScripts,
  resolveWorkspaceRepoScripts,
  resolveWorkspaceRootScripts,
  type WorkspaceScriptResolutionPaths,
} from './script-resolver';
import { readAllSidebarItems } from './sidebar-items';
import { WorkspaceRepoNotFoundError } from './source-layer-resolution';
import {
  getW5IdentityStore,
  W5RevisionConflictError,
} from './w5-commit-log-file-store';
import {
  readWorkspaceConfigDetailed,
  WorkspaceConfigUnreadableError,
} from './workspace-persistence';
import {
  ScriptHookSettingsRefusedError,
  updateWorkspaceScripts,
  type ScriptHookSettingsRefusal,
  type ScriptHookSettingsSource,
} from './workspace-script-hook-settings';

/*
 * The desktop host behind `core.script.definition.*` (CAN-4153): it projects
 * a portable target onto host checkouts, reads the sources the core policy
 * ranks, and applies changes only through the W5 settings command
 * (`core.workspace.scripts.update`), which stays the single settings writer.
 * Source-controlled files are never written.
 */

export async function readSingleRepoProject(
  projectId: string,
): Promise<SingleRepoSidebarItem> {
  const { items } = await readAllSidebarItems();
  const project = items.find(
    (item): item is SingleRepoSidebarItem =>
      item.type === 'single-repo' && item.id === projectId,
  );
  if (!project) {
    throw new RemoteControlServiceError('not_found', 'Project not found.');
  }
  return project;
}

/** A worktree's checkouts instead of the source checkouts. */
function worktreePaths(
  target: CoreScriptTarget,
): WorkspaceScriptResolutionPaths | undefined {
  if (!target.worktreeId || target.kind === 'project') return undefined;
  const workspaceRootPath = getWorkspaceWorktreeRootRepoDir(
    target.workspaceId,
    target.worktreeId,
  );
  return target.kind === 'workspace-root'
    ? { workspaceRootPath }
    : {
        workspaceRootPath,
        repoPath: getWorkspaceWorktreeRepoDir(
          target.workspaceId,
          target.worktreeId,
          target.repoId,
        ),
      };
}

function projectRepoPath(
  target: Extract<CoreScriptTarget, { kind: 'project' }>,
): string | undefined {
  return target.worktreeId
    ? getWorktreeDir(target.workspaceId, target.worktreeId)
    : undefined;
}

const REFUSAL_CODES: Partial<
  Record<ScriptHookSettingsRefusal, CoreScriptErrorCode>
> = {
  'read-only-scope': 'core.script.readOnly',
  'invalid-request': 'core.script.invalidDefinition',
  'not-found': 'core.script.notFound',
  'configuration-unavailable': 'core.script.configurationUnavailable',
};

const COMMIT_REFUSAL_CODES: Partial<
  Record<W5CommitRefusedError['reason'], CoreScriptErrorCode>
> = {
  'revision-conflict': 'core.script.revisionConflict',
  'key-reused': 'core.script.idempotencyKeyReused',
  'in-progress': 'core.script.requestInProgress',
  'recovery-required': 'core.script.recoveryRequired',
  'outcome-expired': 'core.script.outcomeExpired',
};

function scriptErrorCode(error: unknown): CoreScriptErrorCode | undefined {
  if (error instanceof ScriptHookSettingsRefusedError)
    return REFUSAL_CODES[error.reason];
  if (error instanceof W5RevisionConflictError)
    return 'core.script.revisionConflict';
  if (error instanceof W5CommitRefusedError)
    return COMMIT_REFUSAL_CODES[error.reason];
  if (
    error instanceof WorkspaceRepoNotFoundError ||
    (error instanceof RemoteControlServiceError && error.code === 'not_found')
  )
    return 'core.script.notFound';
  return undefined;
}

/** A keyed receipt is scoped to the caller's interface. */
function settingsSource(
  caller: CanopyCallerDescriptor,
): ScriptHookSettingsSource {
  return caller.interfaceKind === 'portal' ? 'portal' : 'desktop';
}

export const desktopScriptDefinitionsHost: CoreScriptDefinitionsHost = {
  async resolve(target) {
    switch (target.kind) {
      case 'project':
        return resolveProjectScripts(
          await readSingleRepoProject(target.workspaceId),
          projectRepoPath(target),
        );
      case 'workspace-root':
        return resolveWorkspaceRootScripts(
          target.workspaceId,
          worktreePaths(target),
        );
      case 'workspace-repo':
        return resolveWorkspaceRepoScripts(
          target.workspaceId,
          target.repoId,
          worktreePaths(target),
        );
    }
  },
  async readLocal(target) {
    if (target.kind === 'project')
      return (await readSingleRepoProject(target.workspaceId)).scripts;
    // The settings writer refuses a manifest it can't read, so a read that
    // plans a change refuses it too instead of reporting no settings.
    const { config, authority } = await readWorkspaceConfigDetailed(
      target.workspaceId,
    );
    if (authority !== 'ok')
      throw new ScriptHookSettingsRefusedError(
        'configuration-unavailable',
        new WorkspaceConfigUnreadableError().message,
      );
    if (target.kind === 'workspace-root') return config.scripts;
    const repo = config.repos.find(
      (candidate) => candidate.id === target.repoId,
    );
    if (!repo)
      throw new ScriptHookSettingsRefusedError(
        'not-found',
        `Repo ${target.repoId} not found in project ${target.workspaceId}`,
      );
    return repo.scripts;
  },
  async localRevision(target) {
    // Only legacy test stores keep no revisions.
    const [current] =
      (await getW5IdentityStore()?.readRevisions([
        { kind: 'workspace', workspaceId: target.workspaceId },
      ])) ?? [];
    return current?.revision;
  },
  async inspect(target, name) {
    switch (target.kind) {
      case 'project': {
        const project = await readSingleRepoProject(target.workspaceId);
        const repoPath = projectRepoPath(target);
        const [resolved, layers] = await Promise.all([
          resolveProjectScripts(project, repoPath),
          collectProjectScriptSourceLayers(project, name, repoPath),
        ]);
        return { resolved, layers };
      }
      case 'workspace-root': {
        const paths = worktreePaths(target);
        const [resolved, layers] = await Promise.all([
          resolveWorkspaceRootScripts(target.workspaceId, paths),
          collectWorkspaceRootScriptSourceLayers(
            target.workspaceId,
            name,
            paths,
          ),
        ]);
        return { resolved, layers };
      }
      case 'workspace-repo': {
        const paths = worktreePaths(target);
        const [resolved, layers] = await Promise.all([
          resolveWorkspaceRepoScripts(target.workspaceId, target.repoId, paths),
          collectWorkspaceRepoScriptSourceLayers(
            target.workspaceId,
            target.repoId,
            name,
            paths,
          ),
        ]);
        return { resolved, layers };
      }
    }
  },
  async change({ target, change, idempotencyKey, expectedRevision, caller }) {
    const repo =
      target.kind === 'workspace-repo' ? { repoId: target.repoId } : {};
    await updateWorkspaceScripts({
      workspaceId: target.workspaceId,
      change:
        change.kind === 'set'
          ? {
              kind: 'definition',
              ...repo,
              name: change.name,
              value: change.value,
            }
          : { kind: 'remove-definition', ...repo, name: change.name },
      source: settingsSource(caller),
      idempotencyKey,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    });
  },
  errorCode: scriptErrorCode,
};
