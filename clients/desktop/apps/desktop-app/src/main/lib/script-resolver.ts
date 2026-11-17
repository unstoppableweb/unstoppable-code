import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { normalizeScriptInputMap } from '@canopy/desktop-shared/scripts';
import { BRAND } from '@canopy/brand/current';
import type {
  ScriptDefinition,
  ScriptOverrides,
  ScriptValue,
} from '@canopy/desktop-shared/scripts';
import type {
  CanopyJsonFile,
  ProjectData,
  ScriptSourceLayer,
  WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import type { CoreScriptSourceLayer } from '@canopy/protocol/canopy-core';
import {
  collectProjectScriptLayers as collectProjectCoreScriptLayers,
  collectWorkspaceRepoScriptLayers as collectWorkspaceRepoCoreScriptLayers,
  collectWorkspaceRootScriptLayers as collectWorkspaceRootCoreScriptLayers,
  resolveProjectScriptMap,
  resolveWorkspaceRepoScriptMap,
  resolveWorkspaceRootScriptMap,
  type ConductorScriptsReader,
  type ResolvedScriptField,
  type ResolvedScriptMap,
  type ScriptConfigFile,
} from '@canopy/core-runtime/node/script/definitions';
import {
  getManifestRepoById,
  getProjectConfigFileCandidates,
  validateCanopyJson,
} from './canopy-json';
import {
  readCachedCanopyJson,
  readCachedConductorJson,
} from './project-config-file-cache';
import { recordMetadataRead } from '@canopy/desktop-shared/node/work-counters';
import {
  readWorkspaceCanopyManifest,
  readWorkspaceRepoLayerContext,
} from './source-layer-resolution';
import { isMissingFileError } from './fs-utils';
import { getBaselineReadPath } from './repo-shadow';
import { readWorkspaceConfig } from './workspace-persistence';

/*
 * The desktop host of script source precedence. Source precedence is
 * core's (`@canopy/core-runtime/node/script/definitions`, CAN-4153); this
 * module only reads the sources it ranks: local settings, the workspace
 * manifest, `canopy.json` candidates and `conductor.json`. A workspace
 * root reads its checkout through the `repo_shadows` baseline
 * (`getBaselineReadPath`), whose Git writer moves with CAN-4108.
 */

export type { ResolvedScriptField, ResolvedScriptMap };

export interface WorkspaceScriptResolutionPaths {
  workspaceRootPath?: string;
  repoPath?: string;
  localConfig?: WorkspaceConfigFile;
}

function conductorReader(path: string): ConductorScriptsReader {
  return () => readCachedConductorJson(path);
}

/** The workspace root checkout, through the `repo_shadows` baseline. */
async function workspaceRootReadPath(
  localConfig: Pick<WorkspaceConfigFile, 'sourceRepoPath'>,
  paths: WorkspaceScriptResolutionPaths | undefined,
): Promise<string | undefined> {
  return (
    paths?.workspaceRootPath ??
    (localConfig.sourceRepoPath
      ? await getBaselineReadPath(localConfig.sourceRepoPath)
      : undefined)
  );
}

export async function resolveProjectScripts(
  project: Pick<ProjectData, 'repoPath' | 'scripts'>,
  repoPathOverride?: string,
): Promise<ResolvedScriptMap> {
  const repoPath = repoPathOverride ?? project.repoPath;
  const repoManifest = await readCachedCanopyJson(repoPath);
  return resolveProjectScriptMap({
    repoScripts: repoManifest?.scripts,
    localScripts: project.scripts,
    readConductor: conductorReader(repoPath),
  });
}

export async function resolveWorkspaceRepoScripts(
  workspaceId: string,
  repoId: string,
  paths?: WorkspaceScriptResolutionPaths,
): Promise<ResolvedScriptMap> {
  const { repo, repoPath, repoManifest, workspaceManifestRepo } =
    await readWorkspaceRepoLayerContext(workspaceId, repoId, paths);
  return resolveWorkspaceRepoScriptMap({
    repoScripts: repoManifest?.scripts,
    workspaceManifestScripts: workspaceManifestRepo?.scripts,
    localScripts: repo.scripts,
    readConductor: conductorReader(repoPath),
  });
}

export async function resolveWorkspaceRootScripts(
  workspaceId: string,
  paths?: WorkspaceScriptResolutionPaths,
): Promise<ResolvedScriptMap> {
  const localConfig =
    paths?.localConfig ?? (await readWorkspaceConfig(workspaceId));
  const workspaceManifest = await readWorkspaceCanopyManifest(
    localConfig,
    paths?.workspaceRootPath,
  );
  const workspaceRootPath = await workspaceRootReadPath(localConfig, paths);
  return resolveWorkspaceRootScriptMap({
    workspaceManifestScripts: workspaceManifest?.scripts,
    localScripts: localConfig.scripts,
    readConductor: workspaceRootPath
      ? conductorReader(workspaceRootPath)
      : undefined,
  });
}

export function getResolvedScriptCommand(
  resolved: ResolvedScriptMap,
  scriptName: string,
): string | undefined {
  return getResolvedScriptDefinition(resolved, scriptName)?.command;
}

export function getResolvedScriptDefinition(
  resolved: ResolvedScriptMap,
  scriptName: string,
): ScriptDefinition | undefined {
  return resolved[scriptName]?.definition;
}

export function getResolvedScriptTimeoutSeconds(
  resolved: ResolvedScriptMap,
  scriptName: string,
): number | null | undefined {
  return getResolvedScriptDefinition(resolved, scriptName)?.timeoutSeconds;
}

export function toScriptOverrides(
  resolved: ResolvedScriptMap,
): ScriptOverrides | undefined {
  const overrides: Record<string, ScriptValue | undefined> = {};

  for (const [name, field] of Object.entries(resolved)) {
    if (!field) {
      continue;
    }
    if (field.definition) {
      overrides[name] = field.definition;
    } else if (
      field.source === 'local-disabled' ||
      field.source === 'workspace-manifest-disabled' ||
      field.source === 'workspace-hook-disabled'
    ) {
      overrides[name] = null;
    }
  }

  return normalizeScriptInputMap(overrides);
}

// ---------------------------------------------------------------------------
// Source layers: every source for a given script, without collapsing.
// ---------------------------------------------------------------------------

interface ConfigCandidateSource {
  fileName: string;
  manifest: CanopyJsonFile | null;
}

async function readConfigCandidateSources(
  repoPath: string,
): Promise<ConfigCandidateSource[]> {
  const candidates: ConfigCandidateSource[] = [];

  for (const filePath of getProjectConfigFileCandidates(repoPath)) {
    try {
      recordMetadataRead('config.read.project-config-layer');
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      candidates.push({
        fileName: basename(filePath),
        manifest: validateCanopyJson(parsed, filePath),
      });
    } catch (error) {
      if (isMissingFileError(error)) {
        candidates.push({ fileName: basename(filePath), manifest: null });
        continue;
      }
      throw error;
    }
  }

  return candidates;
}

function configFiles(
  candidates: readonly ConfigCandidateSource[],
  getScripts: (manifest: CanopyJsonFile) => ScriptConfigFile['scripts'],
): ScriptConfigFile[] {
  return candidates.map(({ fileName, manifest }) => ({
    fileName,
    present: manifest !== null,
    scripts: manifest ? getScripts(manifest) : undefined,
  }));
}

const CONFIG_LABEL_SUFFIX: Partial<
  Record<CoreScriptSourceLayer['source'], string>
> = {
  'workspace-hook': '(project)',
  'workspace-manifest': '(project manifest)',
};

const UNFILED_LABEL: Partial<Record<CoreScriptSourceLayer['source'], string>> =
  {
    'workspace-hook': 'Project config',
    'workspace-manifest': 'Project manifest',
  };

const NOTE_SUFFIX: Record<
  NonNullable<CoreScriptSourceLayer['note']>,
  string
> = {
  'overridden-fallback': ' (overridden fallback)',
  'not-found': ' (not found)',
  'used-config': ' (used config)',
};

/** The desktop's label for a core source layer. */
export function scriptSourceLayerLabel(layer: CoreScriptSourceLayer): string {
  if (layer.source === 'local-override') {
    return `${BRAND.displayName} Local Override`;
  }
  if (!layer.file) {
    return UNFILED_LABEL[layer.source] ?? layer.sourceKey;
  }
  const suffix = CONFIG_LABEL_SUFFIX[layer.source];
  const label = suffix ? `${layer.file} ${suffix}` : layer.file;
  return layer.note ? `${label}${NOTE_SUFFIX[layer.note]}` : label;
}

export function toScriptSourceLayer(
  layer: CoreScriptSourceLayer,
): ScriptSourceLayer {
  return {
    sourceKey: layer.sourceKey,
    sourceLabel: scriptSourceLayerLabel(layer),
    command: layer.command,
    status: layer.status,
  };
}

export async function collectProjectScriptSourceLayers(
  project: Pick<ProjectData, 'repoPath' | 'scripts'>,
  scriptName: string,
  repoPathOverride?: string,
): Promise<CoreScriptSourceLayer[]> {
  const repoPath = repoPathOverride ?? project.repoPath;
  const candidates = await readConfigCandidateSources(repoPath);
  return collectProjectCoreScriptLayers({
    scriptName,
    localScripts: project.scripts,
    repoConfigFiles: configFiles(candidates, (manifest) => manifest.scripts),
    readConductor: conductorReader(repoPath),
  });
}

export async function collectWorkspaceRootScriptSourceLayers(
  workspaceId: string,
  scriptName: string,
  paths?: WorkspaceScriptResolutionPaths,
): Promise<CoreScriptSourceLayer[]> {
  const localConfig = await readWorkspaceConfig(workspaceId);
  const workspaceManifest = await readWorkspaceCanopyManifest(
    localConfig,
    paths?.workspaceRootPath,
  );
  const workspaceRootPath = await workspaceRootReadPath(localConfig, paths);
  const workspaceCandidates = workspaceRootPath
    ? await readConfigCandidateSources(workspaceRootPath)
    : undefined;
  return collectWorkspaceRootCoreScriptLayers({
    scriptName,
    localScripts: localConfig.scripts,
    workspaceConfigFiles:
      workspaceCandidates &&
      configFiles(workspaceCandidates, (manifest) => manifest.scripts),
    workspaceManifestScripts: workspaceManifest?.scripts,
    readConductor: workspaceRootPath
      ? conductorReader(workspaceRootPath)
      : undefined,
  });
}

export async function collectWorkspaceRepoScriptSourceLayers(
  workspaceId: string,
  repoId: string,
  scriptName: string,
  paths?: WorkspaceScriptResolutionPaths,
): Promise<CoreScriptSourceLayer[]> {
  const { localConfig, repo, repoPath, workspaceManifestRepo } =
    await readWorkspaceRepoLayerContext(workspaceId, repoId, paths);
  const workspaceRootPath = await workspaceRootReadPath(localConfig, paths);
  const workspaceCandidates = workspaceRootPath
    ? await readConfigCandidateSources(workspaceRootPath)
    : undefined;
  const repoCandidates = await readConfigCandidateSources(repoPath);
  return collectWorkspaceRepoCoreScriptLayers({
    scriptName,
    localScripts: repo.scripts,
    workspaceConfigFiles:
      workspaceCandidates &&
      configFiles(
        workspaceCandidates,
        (manifest) => getManifestRepoById(manifest, repoId)?.scripts,
      ),
    workspaceManifestScripts: workspaceManifestRepo?.scripts,
    repoConfigFiles: configFiles(
      repoCandidates,
      (manifest) => manifest.scripts,
    ),
    readConductor: conductorReader(repoPath),
  });
}

export async function collectProjectScriptLayers(
  project: Pick<ProjectData, 'repoPath' | 'scripts'>,
  scriptName: string,
  repoPathOverride?: string,
): Promise<ScriptSourceLayer[]> {
  return (
    await collectProjectScriptSourceLayers(
      project,
      scriptName,
      repoPathOverride,
    )
  ).map(toScriptSourceLayer);
}

export async function collectWorkspaceRootScriptLayers(
  workspaceId: string,
  scriptName: string,
  paths?: WorkspaceScriptResolutionPaths,
): Promise<ScriptSourceLayer[]> {
  return (
    await collectWorkspaceRootScriptSourceLayers(workspaceId, scriptName, paths)
  ).map(toScriptSourceLayer);
}

export async function collectWorkspaceRepoScriptLayers(
  workspaceId: string,
  repoId: string,
  scriptName: string,
  paths?: WorkspaceScriptResolutionPaths,
): Promise<ScriptSourceLayer[]> {
  return (
    await collectWorkspaceRepoScriptSourceLayers(
      workspaceId,
      repoId,
      scriptName,
      paths,
    )
  ).map(toScriptSourceLayer);
}
