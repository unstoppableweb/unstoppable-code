import type { Dirent } from 'node:fs';
import { lstat, opendir, readFile, realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import { normalizePipeline } from '@canopy/execution-engine/pipelines/normalize-pipeline';
import { normalizePipelineScopes } from '@canopy/execution-engine/pipelines/scope';
import { getDefaultShellTypeForCurrentProcess } from '@canopy/execution-engine/node/pipelines/default-shell';
import { isPathInside } from '../lib/path-safety';
import { measureSerializedBytes } from '../lib/serialized-size-budget';
import { attachProjectPipelineRemoteMetadata } from './pipeline-service';
import { getProjectPipelinesDirCandidates } from '@canopy/execution-engine/pipelines/config-paths';
import {
  getTriggerTypes,
  type Pipeline,
  type PipelineInfo,
} from '@canopy/execution-engine/types/pipeline';

const PROJECT_PIPELINE_ID_PREFIX = 'project--';

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
}

function isYamlPipelineFile(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return extension === '.yaml' || extension === '.yml';
}

function normalizeRelativePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

export function getCreatedAt(stats: { birthtime: Date; mtime: Date }): string {
  const birthtimeMs = stats.birthtime.getTime();
  if (!Number.isNaN(birthtimeMs) && birthtimeMs > 0) {
    return stats.birthtime.toISOString();
  }

  return stats.mtime.toISOString();
}

export function getProjectPipelineId(relativeFilePath: string): string {
  const parsed = path.posix.parse(normalizeRelativePath(relativeFilePath));
  const idPath = parsed.dir
    ? path.posix.join(parsed.dir, parsed.base)
    : parsed.base;
  return `${PROJECT_PIPELINE_ID_PREFIX}${idPath}`;
}

/**
 * Bounds for unattended discovery (the cloud inventory sync scans every
 * worktree in the background, on repository-controlled trees). Every bound
 * is enforced during enumeration or before a file is read, never after the
 * fact, so a hostile or merely huge checkout costs at most this much work.
 */
export interface DiscoverProjectPipelinesLimits {
  /** Directory entries visited, across every candidate root, before the walk stops. */
  maxEntries: number;
  /** YAML candidates read and parsed before the rest are skipped. */
  maxFiles: number;
  /** Cumulative bytes read; a file that would exceed it is skipped. */
  maxBytes: number;
  /**
   * Scan-wide budget for parsed documents' serialized size, charged (for
   * the measuring work, fit or not) before normalization, so alias
   * amplification is caught before anything copies a document and cannot
   * be multiplied across files.
   */
  maxSerializedBytes: number;
}

/**
 * The bounds every unattended scan of a checkout uses: the cloud inventory
 * sync across worktrees, and a core listing that asks for `bounded` project
 * discovery (the Workflows Library's other-worktree count, CAN-965).
 */
export const UNATTENDED_PROJECT_DISCOVERY_LIMITS: DiscoverProjectPipelinesLimits =
  {
    maxEntries: 5_000,
    maxFiles: 200,
    maxBytes: 4 * 1024 * 1024,
    maxSerializedBytes: 4 * 1024 * 1024,
  };

export interface BoundedProjectPipelineDiscovery {
  pipelines: PipelineInfo[];
  /**
   * True when a bound skipped at least one candidate, cut the walk short,
   * or a pipelines directory was refused because it resolves outside the
   * checkout: the list may be missing pipelines the live path would show.
   */
  truncated: boolean;
}

interface ProjectPipelineDiscovery extends BoundedProjectPipelineDiscovery {
  /** Existing YAML candidates, including files that did not parse. */
  existingFilePaths: string[];
}

interface EnumeratedYamlFiles {
  /** Relative to the pipelines directory, in a deterministic order. */
  files: string[];
  truncated: boolean;
  /** Entries consumed from the budget the caller passed. */
  visited: number;
}

/**
 * Metadata bounds for unattended discovery. js-yaml keeps aliases as shared
 * references, so a small file can carry a `name` or `description` that is
 * an enormous (or alias-amplified) value; the synced summary only ever
 * carries bounded strings.
 */
const MAX_BOUNDED_PIPELINE_NAME_LENGTH = 256;
const MAX_BOUNDED_PIPELINE_DESCRIPTION_LENGTH = 2_048;
const MAX_BOUNDED_PIPELINE_ICON_LENGTH = 64;

function boundedString(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

/**
 * Walk one pipelines directory breadth-first without following symlinked
 * directories (a symlinked file is still listed and validated by the
 * caller), stopping once `maxEntries` entries were visited. Directories are
 * streamed one entry at a time through `opendir`, so a directory with a
 * flood of immediate children is never materialized past the remaining
 * budget; only the bounded set that was read is sorted, which keeps the
 * order deterministic for the files that made it in.
 */
async function enumerateYamlFiles(
  rootDir: string,
  maxEntries: number | undefined,
): Promise<EnumeratedYamlFiles> {
  const files: string[] = [];
  const pendingDirs: string[] = [''];
  let visited = 0;
  while (pendingDirs.length > 0) {
    const relativeDir = pendingDirs.shift() ?? '';
    let dir: Awaited<ReturnType<typeof opendir>>;
    try {
      dir = await opendir(path.join(rootDir, relativeDir));
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') continue;
      throw error;
    }
    const entries: Dirent[] = [];
    let exhausted = false;
    // Breaking out of the iteration closes the directory handle.
    for await (const entry of dir) {
      if (maxEntries !== undefined && visited >= maxEntries) {
        exhausted = true;
        break;
      }
      visited += 1;
      entries.push(entry);
    }
    if (exhausted) {
      // Keep what was read: the files already listed are still valid.
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (entry.isFile() || entry.isSymbolicLink()) {
          files.push(
            relativeDir ? path.join(relativeDir, entry.name) : entry.name,
          );
        }
      }
      return { files, truncated: true, visited };
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDir
        ? path.join(relativeDir, entry.name)
        : entry.name;
      if (entry.isDirectory()) {
        pendingDirs.push(relativePath);
        continue;
      }
      if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(relativePath);
      }
    }
  }
  return { files, truncated: false, visited };
}

/**
 * `full` runs each document through `normalizePipeline`, rejecting any it
 * refuses. `scope` reads only the declared scopes, for a listing: full
 * normalization expands static matrices, so a size-bounded document could
 * still cost a lot of synchronous work (CAN-965).
 */
type DiscoveryValidation = 'full' | 'scope';

async function discover(
  cwd: string,
  limits: DiscoverProjectPipelinesLimits | undefined,
  validation: DiscoveryValidation = 'full',
): Promise<ProjectPipelineDiscovery> {
  const pipelines: PipelineInfo[] = [];
  const existingFilePaths: string[] = [];
  const seenDirs = new Set<string>();
  let truncated = false;
  let filesSeen = 0;
  let bytesRead = 0;
  // One entry budget and one serialized-size budget for the whole scan,
  // shared across candidate roots and files.
  let remainingEntries = limits?.maxEntries;
  let remainingSerializedBytes = limits?.maxSerializedBytes;
  // Bounded discovery is unattended, so a pipelines directory must resolve
  // inside the real checkout: a repository-controlled symlink must not point
  // the scan at arbitrary paths. The live, user-initiated path is not
  // contained this way, so a refusal is reported as truncation.
  const realCwd = limits ? await realpath(cwd) : null;

  for (const pipelinesDir of getProjectPipelinesDirCandidates(cwd)) {
    const normalizedDir = path.resolve(pipelinesDir);
    if (seenDirs.has(normalizedDir)) continue;
    seenDirs.add(normalizedDir);

    if (realCwd !== null) {
      let realDir: string;
      try {
        realDir = await realpath(pipelinesDir);
      } catch (error) {
        if (getErrorCode(error) === 'ENOENT') continue;
        throw error;
      }
      if (!isPathInside(realCwd, realDir)) {
        truncated = true;
        continue;
      }
    }

    const enumerated = await enumerateYamlFiles(pipelinesDir, remainingEntries);
    if (enumerated.truncated) truncated = true;
    if (remainingEntries !== undefined) {
      remainingEntries = Math.max(0, remainingEntries - enumerated.visited);
    }

    for (const entry of enumerated.files) {
      if (!isYamlPipelineFile(entry)) {
        continue;
      }

      const relativeFilePath = normalizeRelativePath(entry);
      const absolutePath = path.join(pipelinesDir, entry);
      if (limits && filesSeen >= limits.maxFiles) {
        truncated = true;
        break;
      }
      filesSeen += 1;

      try {
        const lstats = await lstat(absolutePath);
        if (lstats.isSymbolicLink()) {
          const [resolved, realPipelinesDir] = await Promise.all([
            realpath(absolutePath),
            realpath(pipelinesDir),
          ]);
          if (!isPathInside(realPipelinesDir, resolved)) {
            continue;
          }
        }

        const fileStats = await stat(absolutePath);
        if (!fileStats.isFile()) {
          continue;
        }
        existingFilePaths.push(absolutePath);
        if (limits && bytesRead + fileStats.size > limits.maxBytes) {
          truncated = true;
          continue;
        }
        bytesRead += fileStats.size;
        const raw = await readFile(absolutePath, 'utf8');

        const pipeline: Pipeline = parsePipelineText(raw);
        // Unattended: js-yaml keeps aliases as shared references, so a
        // document within the raw byte budget can still be exponentially
        // larger once anything copies it. Bound its serialized size before
        // normalization or metadata projection touch it; the check stops
        // at the budget instead of expanding the aliases.
        if (remainingSerializedBytes !== undefined) {
          // The walk's cost is charged to one scan-wide budget whether or
          // not the document fit, so many amplified files cannot multiply
          // the work: once the budget is spent every further document is
          // skipped at no cost and reported as truncation.
          const measured = measureSerializedBytes(
            pipeline,
            remainingSerializedBytes,
          );
          remainingSerializedBytes = Math.max(
            0,
            remainingSerializedBytes - measured.bytes,
          );
          if (measured.exceeded) {
            truncated = true;
            continue;
          }
        }
        const normalized =
          validation === 'scope'
            ? { scope: normalizePipelineScopes(pipeline.scope, 'Pipeline') }
            : normalizePipeline(pipeline, {
                defaultShell: getDefaultShellTypeForCurrentProcess(),
              });
        if (limits) {
          // Unattended: metadata must be bounded strings. A name that is
          // not one is a pipeline the summary cannot carry, so it is
          // skipped and reported; description and icon are clamped.
          if (
            typeof pipeline.name !== 'string' ||
            pipeline.name.length > MAX_BOUNDED_PIPELINE_NAME_LENGTH
          ) {
            truncated = true;
            continue;
          }
          pipelines.push({
            id: getProjectPipelineId(relativeFilePath),
            name: pipeline.name,
            description: boundedString(
              pipeline.description,
              MAX_BOUNDED_PIPELINE_DESCRIPTION_LENGTH,
            ),
            icon: boundedString(
              pipeline.icon,
              MAX_BOUNDED_PIPELINE_ICON_LENGTH,
            ),
            filename: relativeFilePath,
            createdAt: getCreatedAt(fileStats),
            updatedAt: fileStats.mtime.toISOString(),
            triggerTypes: getTriggerTypes(pipeline.on),
            stepCount: Object.values(pipeline.jobs).reduce(
              (count, job) => count + job.steps.length,
              0,
            ),
            scopes: normalized.scope,
            source: 'project',
            readonly: true,
            filePath: absolutePath,
          });
          continue;
        }
        pipelines.push({
          id: getProjectPipelineId(relativeFilePath),
          name: pipeline.name,
          description: pipeline.description ?? '',
          icon: pipeline.icon ?? '',
          filename: relativeFilePath,
          createdAt: getCreatedAt(fileStats),
          updatedAt: fileStats.mtime.toISOString(),
          triggerTypes: getTriggerTypes(pipeline.on),
          stepCount: Object.values(pipeline.jobs).reduce(
            (count, job) => count + job.steps.length,
            0,
          ),
          scopes: normalized.scope,
          source: 'project',
          readonly: true,
          filePath: absolutePath,
        });
      } catch (error) {
        const code = getErrorCode(error);
        if (code === 'ENOENT' || code === undefined) {
          continue;
        }
        throw error;
      }
    }
  }

  pipelines.sort((left, right) => left.filename.localeCompare(right.filename));
  return { pipelines, truncated, existingFilePaths };
}

/** Unbounded, user-initiated discovery for the live paths. */
export async function discoverProjectPipelines(
  cwd: string,
): Promise<PipelineInfo[]> {
  const discovered = await discover(cwd, undefined);
  return attachProjectPipelineRemoteMetadata(
    discovered.pipelines,
    cwd,
    true,
    discovered.existingFilePaths,
  );
}

/**
 * Bounded discovery for unattended scans; see
 * {@link DiscoverProjectPipelinesLimits} and
 * {@link BoundedProjectPipelineDiscovery.truncated}.
 */
export async function discoverProjectPipelinesBounded(
  cwd: string,
  limits: DiscoverProjectPipelinesLimits,
): Promise<BoundedProjectPipelineDiscovery> {
  const discovered = await discover(cwd, limits);
  return {
    pipelines: attachProjectPipelineRemoteMetadata(
      discovered.pipelines,
      cwd,
      false,
      discovered.existingFilePaths,
    ),
    truncated: discovered.truncated,
  };
}

/**
 * Bounded discovery that writes nothing and does no normalization work: no
 * share-link metadata is attached or reconciled, so a read of a checkout
 * nobody opened (the Library's count of other worktrees' project pipelines,
 * CAN-965) never moves a published workflow's saved binding, and only each
 * document's declared scopes are validated, so no static matrix is
 * expanded. Rows carry no author-side share link, and a document that
 * parses with valid scopes is listed even where a run would refuse it.
 */
export async function readProjectPipelinesWithinBounds(
  cwd: string,
  limits: DiscoverProjectPipelinesLimits,
  /**
   * `full` lists only documents that pass the run's own normalization, as
   * the scheduler's discovery does, still writing nothing (CAN-5782).
   */
  validation: DiscoveryValidation = 'scope',
): Promise<BoundedProjectPipelineDiscovery> {
  const { pipelines, truncated } = await discover(cwd, limits, validation);
  return { pipelines, truncated };
}

export async function loadProjectPipelineFromDisk(
  filePath: string,
): Promise<Pipeline> {
  const raw = await readFile(filePath, 'utf8');
  return parsePipelineText(raw);
}
