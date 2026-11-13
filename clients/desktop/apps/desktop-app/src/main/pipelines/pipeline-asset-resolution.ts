import { mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { normalizePipelineAssets } from '@canopy/pipeline-interop/assets';
import {
  pipelineDataDir,
  pipelineDataKey,
  resolvePipelineAssets,
} from '@canopy/desktop-shared/node/pipelines/pipeline-assets';
import type { ExecutionOptions } from '@canopy/execution-engine/node/pipelines/executor';
import type { Pipeline } from '@canopy/execution-engine/types/pipeline';
import { getPipelineDataRoot } from '../lib/paths';

/** The executor fields main fills before a top-level run starts. */
export type PipelineAssetExecutionOptions = Pick<
  ExecutionOptions,
  'assetPaths' | 'pipelineDataDir' | 'assetsDir'
>;

export type PipelineAssetResolution =
  | { ok: true; options: PipelineAssetExecutionOptions }
  | { ok: false; message: string };

/**
 * Who the run's data dir belongs to. A stored user pipeline has a local id;
 * every other pipeline is keyed by a stable source identity (the absolute
 * file path for project pipelines). A run with neither gets no data dir, and
 * its assets resolve from their declared paths only.
 */
export interface PipelineAssetIdentity {
  localPipelineId?: string;
  sourcePath?: string;
}

async function directoryExists(directoryPath: string): Promise<boolean> {
  try {
    return (await stat(directoryPath)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve a top-level run's `assets` and data dir before the executor starts,
 * creating the data dir. A missing required asset fails here, before any
 * step runs, with a message naming the asset.
 */
export async function resolvePipelineAssetExecutionOptions(input: {
  pipeline: Pipeline;
  identity: PipelineAssetIdentity;
  dataRoot?: string;
  home?: string;
}): Promise<PipelineAssetResolution> {
  let assets: ReturnType<typeof normalizePipelineAssets>;
  try {
    assets = normalizePipelineAssets(input.pipeline.assets);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const { localPipelineId, sourcePath } = input.identity;
  const dataKey =
    localPipelineId || sourcePath
      ? pipelineDataKey({
          ...(localPipelineId ? { localPipelineId } : {}),
          sourcePath: sourcePath ?? '',
        })
      : undefined;
  const dataRoot = input.dataRoot ?? getPipelineDataRoot();
  const resolved = await resolvePipelineAssets({
    assets: assets ?? [],
    dataRoot,
    ...(dataKey === undefined ? {} : { dataKey }),
    homedir: input.home ?? homedir(),
    directoryExists,
  });
  if (!resolved.ok) return { ok: false, message: resolved.message };
  const options: PipelineAssetExecutionOptions = {
    ...(assets ? { assetPaths: resolved.assetPaths } : {}),
  };
  if (dataKey !== undefined) {
    const dataDir = pipelineDataDir(dataRoot, dataKey);
    await mkdir(dataDir, { recursive: true });
    options.pipelineDataDir = dataDir;
    if (
      assets &&
      resolved.assetsDir !== undefined &&
      (await directoryExists(resolved.assetsDir))
    ) {
      options.assetsDir = resolved.assetsDir;
    }
  }
  return { ok: true, options };
}
