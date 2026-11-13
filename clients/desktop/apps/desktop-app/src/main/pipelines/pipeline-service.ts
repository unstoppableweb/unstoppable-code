import * as fs from 'node:fs';
import * as path from 'node:path';
import { isStorageOutcomeUnknownError } from '@canopy/core-runtime/storage';
import { writeFileAtomicallySync } from '@canopy/execution-engine/node/lib/atomic-file';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  getProjectPipelinesDirCandidates,
  getUserPipelinesDir,
} from './config-paths';
import type {
  IPCResult,
  PipelineInfo,
} from '@canopy/execution-engine/types/pipeline';
import {
  parseShareRemoteMetadata,
  type ShareRemoteMetadata,
} from '@canopy/protocol/sharing';

export {
  clearStoredPipelineRemoteMetadataByRemoteId as clearPipelineRemoteMetadataByRemoteId,
  deleteStoredPipeline as deletePipeline,
  duplicateStoredPipeline as duplicatePipeline,
  getStoredPipeline as getPipeline,
  getStoredPipelineBySource,
  getStoredPipelinePath as getPipelinePath,
  getStoredPipelineText as getPipelineText,
  listStoredPipelines as listPipelines,
  saveStoredPipeline as savePipeline,
  writeStoredPipelineRemoteMetadata as writePipelineRemoteMetadata,
  updateStoredPipeline as updatePipeline,
} from '@canopy/execution-engine/pipelines/store';

export { listPipelineCapabilityData } from './pipeline-capability-data';

const PROJECT_PIPELINE_SHARE_LINKS_FILE = '.project-share-links.json';

interface ProjectPipelineShareLink {
  remote: ShareRemoteMetadata;
  /** Filesystem identity of the checkout/worktree root. */
  rootIdentity: string;
  /** Filesystem identity used to follow a Pipeline when it is renamed. */
  fileIdentity: string;
}

function getProjectPipelineShareLinksPath(): string {
  return path.join(getUserPipelinesDir(), PROJECT_PIPELINE_SHARE_LINKS_FILE);
}

function projectPipelineShareLinkKey(filePath: string): string {
  return path.resolve(filePath);
}

function filesystemIdentity(filePath: string): string {
  const stats = fs.statSync(filePath);
  return `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`;
}

function projectPipelineRoot(filePath: string): string {
  const resolvedFilePath = path.resolve(filePath);
  let candidateRoot = path.dirname(resolvedFilePath);
  while (true) {
    if (
      getProjectPipelinesDirCandidates(candidateRoot).some((pipelinesDir) => {
        const relative = path.relative(
          path.resolve(pipelinesDir),
          resolvedFilePath,
        );
        return (
          relative.length > 0 &&
          relative !== '..' &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative)
        );
      })
    ) {
      return candidateRoot;
    }
    const parent = path.dirname(candidateRoot);
    if (parent === candidateRoot) {
      throw new Error(
        'Project Pipeline is outside a project pipelines folder.',
      );
    }
    candidateRoot = parent;
  }
}

function parseProjectPipelineShareLink(
  value: unknown,
): ProjectPipelineShareLink | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const remote = parseShareRemoteMetadata(record.remote);
  if (
    !remote ||
    typeof record.rootIdentity !== 'string' ||
    record.rootIdentity.length === 0 ||
    typeof record.fileIdentity !== 'string' ||
    record.fileIdentity.length === 0
  ) {
    return undefined;
  }
  return {
    remote,
    rootIdentity: record.rootIdentity,
    fileIdentity: record.fileIdentity,
  };
}

function readProjectPipelineShareLinks(): Record<
  string,
  ProjectPipelineShareLink
> {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(getProjectPipelineShareLinksPath(), 'utf8'),
    );
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error('Invalid project Pipeline share-link catalog.');
    }
    const links: Record<string, ProjectPipelineShareLink> = {};
    for (const [filePath, value] of Object.entries(parsed)) {
      const link = parseProjectPipelineShareLink(value);
      if (!link) {
        throw new Error('Invalid project Pipeline share-link catalog.');
      }
      links[projectPipelineShareLinkKey(filePath)] = link;
    }
    return links;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

function writeProjectPipelineShareLinks(
  links: Record<string, ProjectPipelineShareLink>,
): void {
  const filePath = getProjectPipelineShareLinksPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    writeFileAtomicallySync(filePath, `${JSON.stringify(links, null, 2)}\n`, {
      encoding: 'utf8',
      durable: true,
      admittedWriter: {
        namespace: 'pipeline_definitions',
        writer: 'electron_main',
        module: 'main/pipelines/pipeline-service',
      },
    });
  } catch (error) {
    if (!isStorageOutcomeUnknownError(error)) throw error;
    logMainProcessWarn(
      '[pipelines] Project share links installed, but their folder flush failed.',
      error,
    );
  }
}

/** Persist the author-side cloud link for a read-only project definition. */
export function writeProjectPipelineRemoteMetadata(
  filePath: string,
  remote: ShareRemoteMetadata,
): IPCResult {
  try {
    const links = readProjectPipelineShareLinks();
    const rootPath = projectPipelineRoot(filePath);
    links[projectPipelineShareLinkKey(filePath)] = {
      remote: { ...remote },
      rootIdentity: filesystemIdentity(rootPath),
      fileIdentity: filesystemIdentity(filePath),
    };
    writeProjectPipelineShareLinks(links);
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

/** Add persisted author-side links to project definitions during discovery. */
export function attachProjectPipelineRemoteMetadata(
  pipelines: PipelineInfo[],
  projectRootPath: string,
  pruneMissing: boolean,
  existingFilePaths: readonly string[] = pipelines.flatMap((pipeline) =>
    pipeline.filePath ? [pipeline.filePath] : [],
  ),
): PipelineInfo[] {
  let links: Record<string, ProjectPipelineShareLink>;
  try {
    links = readProjectPipelineShareLinks();
  } catch {
    // A damaged optional link catalog must not hide runnable project YAML.
    return pipelines;
  }
  let rootIdentity: string;
  try {
    rootIdentity = filesystemIdentity(projectRootPath);
  } catch {
    return pipelines;
  }
  let changed = false;
  const matchedKeys = new Set<string>();
  for (const filePath of existingFilePaths) {
    const key = projectPipelineShareLinkKey(filePath);
    let link: ProjectPipelineShareLink | undefined = links[key];
    if (link && link.rootIdentity !== rootIdentity) {
      delete links[key];
      link = undefined;
      changed = true;
    }
    let fileIdentity: string;
    try {
      fileIdentity = filesystemIdentity(filePath);
    } catch {
      continue;
    }
    if (!link) {
      const renamedMatches = Object.entries(links).filter(
        ([candidateKey, candidate]) =>
          !matchedKeys.has(candidateKey) &&
          candidate.rootIdentity === rootIdentity &&
          candidate.fileIdentity === fileIdentity,
      );
      if (renamedMatches.length === 1) {
        const [previousKey, renamedLink] = renamedMatches[0];
        delete links[previousKey];
        links[key] = renamedLink;
        link = renamedLink;
        changed = true;
      }
    } else if (link.fileIdentity !== fileIdentity) {
      link = { ...link, fileIdentity };
      links[key] = link;
      changed = true;
    }
    if (link) matchedKeys.add(key);
  }
  const hydrated = pipelines.map((pipeline) => {
    if (!pipeline.filePath) return pipeline;
    const key = projectPipelineShareLinkKey(pipeline.filePath);
    let link: ProjectPipelineShareLink | undefined = links[key];
    if (link && link.rootIdentity !== rootIdentity) {
      delete links[key];
      link = undefined;
      changed = true;
    }

    let fileIdentity: string;
    try {
      fileIdentity = filesystemIdentity(pipeline.filePath);
    } catch {
      return pipeline;
    }
    if (!link) {
      const renamedMatches = Object.entries(links).filter(
        ([candidateKey, candidate]) =>
          !matchedKeys.has(candidateKey) &&
          candidate.rootIdentity === rootIdentity &&
          candidate.fileIdentity === fileIdentity,
      );
      if (renamedMatches.length === 1) {
        const [previousKey, renamedLink] = renamedMatches[0];
        delete links[previousKey];
        links[key] = renamedLink;
        link = renamedLink;
        changed = true;
      }
    } else if (link.fileIdentity !== fileIdentity) {
      // Editors commonly replace a file atomically. The unchanged project
      // root plus exact logical path keeps the binding valid while refreshing
      // the identity used for a later rename.
      link = { ...link, fileIdentity };
      links[key] = link;
      changed = true;
    }
    if (!link) return pipeline;
    matchedKeys.add(key);
    return { ...pipeline, remote: { ...link.remote } };
  });

  if (pruneMissing) {
    for (const [key, link] of Object.entries(links)) {
      if (link.rootIdentity !== rootIdentity || matchedKeys.has(key)) continue;
      delete links[key];
      changed = true;
    }
  }
  if (changed) {
    try {
      writeProjectPipelineShareLinks(links);
    } catch {
      // Link reconciliation is best effort; discovery must still return the
      // runnable project definitions and any links already matched in memory.
    }
  }
  return hydrated;
}

/** Clear every project definition linked to a deleted cloud share. */
export function clearProjectPipelineRemoteMetadataByRemoteId(
  remoteId: string,
): IPCResult<number> {
  try {
    const links = readProjectPipelineShareLinks();
    let count = 0;
    for (const [filePath, link] of Object.entries(links)) {
      if (link.remote.remoteId !== remoteId) continue;
      delete links[filePath];
      count += 1;
    }
    if (count > 0) writeProjectPipelineShareLinks(links);
    return { success: true, data: count };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}
