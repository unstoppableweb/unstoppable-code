import { backgroundExecutionDeniedMessage } from '@canopy/execution-engine/lib/automation-context-copy';
import type { ResourceContextInput } from '@canopy/execution-engine/lib/resource-context-policy';
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type {
  ChildPipelineAuthorization,
  Pipeline,
  PipelinePreferenceLocator,
} from '@canopy/execution-engine/types/pipeline';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import { getStoredPipelinePathWithSource } from '@canopy/execution-engine/pipelines/store';
import { isPathInside } from '@canopy/execution-engine/node/lib/path-safety';
import { getBundledPipelinesDir } from '@canopy/execution-engine/node/pipelines/config-paths';
import type { PipelinePackageCapabilityOverlay } from '@canopy/execution-engine/types/pipeline';

export interface ResolvedChildPipeline {
  pipeline: Pipeline;
  pipelineId: string;
  bundled?: boolean;
  /** Pinned by the parent's reviewed capability package; owned by the parent. */
  packaged?: boolean;
  pipelineFileDir?: string;
  preferenceLocator?: PipelinePreferenceLocator;
}

/** Host resolves ownership/provenance from the executing parent, never the child YAML. */
export interface PipelineResourceParent {
  pipelineId?: string;
  projectId?: string;
  cwd?: string;
  pipelineFileDir?: string;
  /** In-memory file source locator, independent of the execution target. */
  pipelineSource?: { cwd: string; filePath: string };
}

export type { ChildPipelineAuthorization } from '@canopy/execution-engine/types/pipeline';

/** Bind the resolved definition to the exact parent lookup, never just a basename. */
export function childPipelineAuthorization(
  args: ResolveChildPipelineArgs,
  child: ResolvedChildPipeline,
): ChildPipelineAuthorization {
  return {
    request: JSON.stringify([
      args.cwd,
      args.pipelineFileDir,
      args.pipelineRef?.trim(),
      args.pipelineYaml?.trim(),
    ]),
    identity: JSON.stringify(child.preferenceLocator ?? { inline: true }),
    contentHash: createHash('sha256')
      .update(JSON.stringify(child.pipeline))
      .digest('hex'),
  };
}

export interface ResolveChildPipelineArgs {
  authorizations?: readonly ChildPipelineAuthorization[];
  parent?: ResourceContextInput['resource'];
  resolvePipelineResource?: (
    reference: string,
    parent?: ResourceContextInput['resource'],
    file?: { cwd: string; filePath: string },
  ) => Promise<ResolvedChildPipeline | undefined>;
  pipelineRef?: string;
  pipelineYaml?: string;
  cwd: string;
  pipelineFileDir?: string;
  repoPath?: string;
  getProjectPipelinesDirCandidates?: (repoPath: string) => string[];
  packageOverlay?: PipelinePackageCapabilityOverlay;
}

export async function loadPipelineFromPath(
  filePath: string,
): Promise<Pipeline> {
  const raw = await fsp.readFile(filePath, 'utf8');
  return parsePipelineText(raw);
}

async function tryLoadFromCandidates(
  rootDir: string,
  ref: string,
  escapeMessage: string,
): Promise<ResolvedChildPipeline | null> {
  const hasExtension = path.extname(ref).length > 0;
  const candidateRefs = hasExtension
    ? [ref]
    : [ref, `${ref}.yaml`, `${ref}.yml`];

  for (const candidateRef of candidateRefs) {
    const candidatePath = path.resolve(rootDir, candidateRef);
    if (!isPathInside(rootDir, candidatePath)) {
      throw new Error(escapeMessage);
    }

    try {
      const realCandidate = await fsp.realpath(candidatePath);
      const realRoot = await fsp.realpath(rootDir);
      if (!isPathInside(realRoot, realCandidate)) {
        throw new Error(escapeMessage);
      }
    } catch (realpathError) {
      if (
        typeof realpathError !== 'object' ||
        realpathError === null ||
        Reflect.get(realpathError, 'code') !== 'ENOENT'
      ) {
        throw realpathError;
      }
    }

    try {
      const stats = await fsp.stat(candidatePath);
      if (!stats.isFile()) {
        continue;
      }

      return {
        pipeline: await loadPipelineFromPath(candidatePath),
        pipelineId: path.basename(candidatePath),
        pipelineFileDir: path.dirname(candidatePath),
        preferenceLocator: {
          type: 'file',
          value: candidatePath,
        },
      };
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        Reflect.get(error, 'code') !== 'ENOENT'
      ) {
        throw error;
      }
    }
  }

  return null;
}

async function resolveUncheckedChildPipeline(
  args: ResolveChildPipelineArgs,
): Promise<ResolvedChildPipeline> {
  const authorizeFile = async (
    resolved: ResolvedChildPipeline,
  ): Promise<ResolvedChildPipeline> => {
    if (resolved.preferenceLocator?.type === 'file')
      await args.resolvePipelineResource?.(
        args.pipelineRef?.trim() ?? '',
        args.parent,
        {
          cwd: args.repoPath ?? args.cwd,
          filePath: resolved.preferenceLocator.value,
        },
      );
    return resolved;
  };
  const trimmedRef = args.pipelineRef?.trim();
  if (trimmedRef) {
    const packaged = args.packageOverlay?.resources.find(
      (resource) =>
        resource.kind === 'child_pipeline' &&
        resource.invocationKeys.includes(trimmedRef),
    );
    if (packaged) {
      const resolved = await tryLoadFromCandidates(
        packaged.rootPath,
        trimmedRef,
        `Child workflow ref "${trimmedRef}" escapes its package resource`,
      );
      if (resolved) return { ...resolved, packaged: true };
      throw new Error(
        `Unable to resolve packaged child workflow "${trimmedRef}"`,
      );
    }
    const resource = await args.resolvePipelineResource?.(
      trimmedRef,
      args.parent,
    );
    if (resource) return resource;
    const stored = getStoredPipelinePathWithSource(trimmedRef);
    if (stored.success && stored.data) {
      return {
        pipeline: await loadPipelineFromPath(stored.data.filePath),
        pipelineId: trimmedRef,
        pipelineFileDir: path.dirname(stored.data.filePath),
        preferenceLocator: {
          type: 'stored',
          source: stored.data.source,
          value: trimmedRef,
        },
      };
    }

    if (path.isAbsolute(trimmedRef)) {
      throw new Error(
        `Absolute child workflow refs are not allowed: "${trimmedRef}"`,
      );
    }

    if (args.pipelineFileDir) {
      const relativeToFile = await tryLoadFromCandidates(
        args.pipelineFileDir,
        trimmedRef,
        `Child workflow ref "${trimmedRef}" escapes parent workflow directory`,
      );
      if (relativeToFile) {
        return authorizeFile(relativeToFile);
      }
    }

    if (args.repoPath && args.getProjectPipelinesDirCandidates) {
      for (const projectPipelinesDir of args.getProjectPipelinesDirCandidates(
        args.repoPath,
      )) {
        const relativeToProject = await tryLoadFromCandidates(
          projectPipelinesDir,
          trimmedRef,
          `Child workflow ref "${trimmedRef}" escapes project pipelines directory`,
        );
        if (relativeToProject) {
          return authorizeFile(relativeToProject);
        }
      }
    }

    const relativeToCwd = await tryLoadFromCandidates(
      args.cwd,
      trimmedRef,
      `Child workflow ref "${trimmedRef}" escapes execution cwd`,
    );
    if (relativeToCwd) {
      return authorizeFile(relativeToCwd);
    }

    const bundledPipelinesDir = getBundledPipelinesDir();
    const relativeToBundled = await tryLoadFromCandidates(
      bundledPipelinesDir,
      trimmedRef,
      `Child workflow ref "${trimmedRef}" escapes bundled pipelines directory`,
    );
    if (relativeToBundled) {
      return authorizeFile({ ...relativeToBundled, bundled: true });
    }

    throw new Error(`Unable to resolve child workflow "${trimmedRef}"`);
  }

  const trimmedYaml = args.pipelineYaml?.trim();
  if (!trimmedYaml) {
    throw new Error('run-pipeline requires pipeline or pipeline_yaml');
  }

  return {
    pipeline: parsePipelineText(trimmedYaml),
    pipelineId: 'inline-pipeline',
  };
}

export async function resolveChildPipeline(
  args: ResolveChildPipelineArgs,
): Promise<ResolvedChildPipeline> {
  const child = await resolveUncheckedChildPipeline(args);
  if (args.authorizations !== undefined) {
    const actual = childPipelineAuthorization(args, child);
    if (
      !args.authorizations.some(
        (entry) =>
          entry.request === actual.request &&
          entry.identity === actual.identity &&
          entry.contentHash === actual.contentHash,
      )
    ) {
      throw new Error(backgroundExecutionDeniedMessage('unsupported-target'));
    }
  }
  return child;
}
