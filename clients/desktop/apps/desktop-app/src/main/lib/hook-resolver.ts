import {
  normalizeHookInputMap,
  type HookAction,
  type HookOverrides,
} from '@canopy/desktop-shared/hooks';
import { BRAND } from '@canopy/brand/current';
import type {
  HookSourceLayer,
  ProjectData,
  WorkspaceConfigFile,
  WorkspaceRepoData,
} from '@canopy/desktop-shared/types';
import type { CoreHookSourceLayerKey } from '@canopy/protocol/canopy-core';
import {
  collectHookSourceLayers,
  isDisabledHookSource,
  resolveLayeredHookSources,
  type HookSourceField,
  type HookSourceLayerRead,
  type HookSourceMap,
} from '@canopy/core-runtime/node/initiated-work/hook-sources';
import { settleAll } from '@canopy/desktop-shared/node/lib/detached-work';
import { readCachedCanopyJson } from './project-config-file-cache';
import {
  resolveWorkspaceRepoScripts,
  toScriptOverrides,
} from './script-resolver';
import {
  readWorkspaceCanopyManifest,
  readWorkspaceRepoLayerContext,
  type WorkspaceRepoLayerPaths,
} from './source-layer-resolution';
import { readWorkspaceConfig } from './workspace-persistence';
import { recordOrganizationHookBindings } from './workspace-ownership';

/*
 * Host side of hook source resolution. The layering policy lives in
 * core-runtime behind `core.initiatedWork.source.*`; these functions read
 * each target's layers from local files and apply the W5 ownership decision.
 */

export type ResolvedHookField = HookSourceField<HookAction>;

export type ResolvedHookMap = HookSourceMap<HookAction>;

export type HookLayerRead = HookSourceLayerRead<HookAction>;

export interface WorkspaceHookResolutionPaths {
  workspaceRootPath?: string;
  repoPath?: string;
  localConfig?: WorkspaceConfigFile;
}

type ProjectHookSource = Pick<ProjectData, 'repoPath' | 'hooks'> &
  Partial<Pick<ProjectData, 'id' | 'owner'>>;

export async function readProjectHookLayers(
  project: ProjectHookSource,
  repoPathOverride?: string,
): Promise<HookLayerRead> {
  const repoManifest = await readCachedCanopyJson(
    repoPathOverride ?? project.repoPath,
  );
  return {
    layers: {
      scope: 'project',
      sourceHooks: repoManifest?.hooks,
      localHooks: project.hooks,
    },
    bindLocalHooks: async () =>
      project.id === undefined || project.owner === undefined
        ? { hooks: project.hooks, owner: project.owner }
        : recordOrganizationHookBindings({
            workspaceId: project.id,
            source: 'hook_resolution',
            sourceHooks: repoManifest?.hooks,
            localHooks: project.hooks,
            owner: project.owner,
          }),
  };
}

export async function readWorkspaceRootHookLayers(
  workspaceId: string,
  paths?: WorkspaceHookResolutionPaths,
): Promise<HookLayerRead> {
  const localConfig =
    paths?.localConfig ?? (await readWorkspaceConfig(workspaceId));
  const workspaceManifest = await readWorkspaceCanopyManifest(
    localConfig,
    paths?.workspaceRootPath,
  );
  return {
    layers: {
      scope: 'workspace-root',
      sourceHooks: workspaceManifest?.hooks,
      localHooks: localConfig.hooks,
    },
    bindLocalHooks: async () =>
      localConfig.owner === undefined
        ? { hooks: localConfig.hooks, owner: undefined }
        : recordOrganizationHookBindings({
            workspaceId,
            source: 'hook_resolution',
            sourceHooks: workspaceManifest?.hooks,
            localHooks: localConfig.hooks,
            owner: localConfig.owner,
          }),
  };
}

export async function readWorkspaceRepoHookLayers(
  workspaceId: string,
  repoId: string,
  paths?: WorkspaceHookResolutionPaths,
): Promise<HookLayerRead> {
  const { localConfig, repo, repoManifest, workspaceManifestRepo } =
    await readWorkspaceRepoLayerContext(workspaceId, repoId, paths);
  return {
    layers: {
      scope: 'workspace-repo',
      sourceHooks: repoManifest?.hooks,
      manifestHooks: workspaceManifestRepo?.hooks,
      localHooks: repo.hooks,
    },
    bindLocalHooks: async (resolved) =>
      localConfig.owner === undefined
        ? { hooks: repo.hooks, owner: undefined }
        : recordOrganizationHookBindings({
            workspaceId,
            repoId,
            source: 'hook_resolution',
            sourceHooks: toHookOverrides(resolved),
            localHooks: repo.hooks,
            owner: localConfig.owner,
          }),
  };
}

function resolveHookLayerRead(read: HookLayerRead): Promise<ResolvedHookMap> {
  return resolveLayeredHookSources(read.layers, read.bindLocalHooks);
}

export async function resolveProjectHooks(
  project: ProjectHookSource,
  repoPathOverride?: string,
): Promise<ResolvedHookMap> {
  return resolveHookLayerRead(
    await readProjectHookLayers(project, repoPathOverride),
  );
}

export async function resolveWorkspaceRootHooks(
  workspaceId: string,
  paths?: WorkspaceHookResolutionPaths,
): Promise<ResolvedHookMap> {
  return resolveHookLayerRead(
    await readWorkspaceRootHookLayers(workspaceId, paths),
  );
}

export async function resolveWorkspaceRepoHooks(
  workspaceId: string,
  repoId: string,
  paths?: WorkspaceHookResolutionPaths,
): Promise<ResolvedHookMap> {
  return resolveHookLayerRead(
    await readWorkspaceRepoHookLayers(workspaceId, repoId, paths),
  );
}

export function getResolvedHookActions(
  resolved: ResolvedHookMap,
  triggerName: string,
): HookAction[] | null {
  const field = resolved[triggerName];
  return Array.isArray(field?.actions) ? field.actions : null;
}

export function toHookOverrides(
  resolved: ResolvedHookMap,
): HookOverrides | undefined {
  const overrides: Record<string, HookAction[] | null | undefined> = {};

  for (const [triggerName, field] of Object.entries(resolved)) {
    if (Array.isArray(field.actions)) {
      overrides[triggerName] = field.actions;
    } else if (isDisabledHookSource(field.source)) {
      overrides[triggerName] = null;
    }
  }

  return normalizeHookInputMap(overrides);
}

const HOOK_SOURCE_LAYER_LABELS: Record<CoreHookSourceLayerKey, string> = {
  'local-override': `${BRAND.displayName} Local Override`,
  'workspace-manifest': 'canopy.json (project manifest)',
  'repo-canopy': 'canopy.json',
  'workspace-hook': 'canopy.json (project)',
};

/** Adds the display label to each core source layer. */
export function labelHookSourceLayers(
  layers: ReadonlyArray<{
    sourceKey: CoreHookSourceLayerKey;
    actions: HookAction[] | null;
    status: HookSourceLayer['status'];
  }>,
): HookSourceLayer[] {
  return layers.map((layer) => ({
    sourceKey: layer.sourceKey,
    sourceLabel: HOOK_SOURCE_LAYER_LABELS[layer.sourceKey],
    actions: layer.actions,
    status: layer.status,
  }));
}

function collectHookLayers(
  read: HookLayerRead,
  triggerName: string,
): HookSourceLayer[] {
  return labelHookSourceLayers(
    collectHookSourceLayers(read.layers, triggerName),
  );
}

export async function collectProjectHookLayers(
  project: Pick<ProjectData, 'repoPath' | 'hooks'>,
  triggerName: string,
  repoPathOverride?: string,
): Promise<HookSourceLayer[]> {
  return collectHookLayers(
    await readProjectHookLayers(project, repoPathOverride),
    triggerName,
  );
}

export async function collectWorkspaceRootHookLayers(
  workspaceId: string,
  triggerName: string,
  paths?: WorkspaceHookResolutionPaths,
): Promise<HookSourceLayer[]> {
  return collectHookLayers(
    await readWorkspaceRootHookLayers(workspaceId, {
      workspaceRootPath: paths?.workspaceRootPath,
    }),
    triggerName,
  );
}

export async function collectWorkspaceRepoHookLayers(
  workspaceId: string,
  repoId: string,
  triggerName: string,
  paths?: WorkspaceHookResolutionPaths,
): Promise<HookSourceLayer[]> {
  return collectHookLayers(
    await readWorkspaceRepoHookLayers(workspaceId, repoId, paths),
    triggerName,
  );
}

export async function resolveWorkspaceRepoDataHooks(
  workspaceId: string,
  repo: WorkspaceRepoData,
  paths?: WorkspaceRepoLayerPaths,
): Promise<WorkspaceRepoData> {
  const [resolvedScripts, resolvedHooks] = await settleAll([
    resolveWorkspaceRepoScripts(workspaceId, repo.id, paths),
    resolveWorkspaceRepoHooks(workspaceId, repo.id, paths),
  ]);

  return {
    ...repo,
    effectiveScripts: toScriptOverrides(resolvedScripts),
    effectiveHooks: toHookOverrides(resolvedHooks),
  };
}
