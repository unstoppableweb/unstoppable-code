import type { PipelineReadPort } from './port';
/**
 * Source-aware loading of a full pipeline document (`PipelineData`) from a
 * list-level {@link PipelineInfo} row.
 *
 * The pipeline list only carries `PipelineInfo` (catalog metadata), but
 * surfaces that need the parsed definition — the editor, and the row-level
 * Share flow on the Pipelines page — must fetch the document on demand. The
 * dispatch differs per source, so it lives here once rather than being
 * re-derived at each call site:
 *
 * - `shared`  → `port.pipelines.getShared({ remoteId })`, then
 *   {@link sharedDetailToPipelineData} to rebuild renderer-shaped info.
 * - `project` → `port.pipelines.get({ id, cwd, filePath })`.
 * - otherwise → `port.pipelines.get({ id, source })`, falling back to the
 *   bare-id lookup when the source is not a stored-catalog namespace.
 *
 * `usePipelineEditor` consumes {@link loadPipelineDocument} so the editor and
 * the Share flow cannot drift apart.
 */
import * as yaml from 'js-yaml';
import type { PipelineRepairShareTarget } from '@canopy/protocol/capability-package-repair';
import { CANOPY_CLOUD_SERVER_ID } from '../../constants/canopy-cloud';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import type {
  Pipeline,
  PipelineData,
  PipelineInfo,
  SharedPipelineDetail,
} from '@canopy/execution-engine/types/pipeline';
import {
  COWORK_HOME_WORKTREE_ID,
  WORKSPACE_ROOT_REPO_ID,
  type AutomationAction,
} from '../../types';
import {
  pipelineAutomationTaskId,
  pipelineAutomationWorkspaceId,
} from '../automation-pipeline-target';

/**
 * Canonical YAML serialization for a pipeline document.
 *
 * `hashPipelinePackageYaml` hashes exactly these bytes, so every surface that
 * needs a pipeline's content hash must serialize through here. Two independent
 * `yaml.dump` call sites with drifting options would produce two different
 * hashes for the same pipeline, and a pipeline bundled into a shared
 * automation would then fail the recipient's local integrity check.
 */
export function serializePipelineDocument(pipeline: Pipeline): string {
  return yaml.dump({ pipeline }, { lineWidth: 120, noRefs: true });
}

/**
 * SHA-256 of a serialized pipeline document, matching the main-process
 * `hashPipelinePackageYaml`. That helper lives on `node:crypto` and cannot be
 * imported here, so the renderer computes the same digest through Web Crypto.
 *
 * Returns `null` when Web Crypto is unavailable, so callers degrade to the
 * unbundled document rather than shipping bytes with no integrity pin.
 */
export async function hashPipelineDocumentYaml(
  rawPipeline: string,
): Promise<string | null> {
  const subtle =
    typeof globalThis !== 'undefined' &&
    typeof globalThis.crypto !== 'undefined'
      ? globalThis.crypto.subtle
      : undefined;
  if (!subtle) return null;
  const buffer = await subtle.digest(
    'SHA-256',
    new TextEncoder().encode(rawPipeline),
  );
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Stored-catalog namespaces addressable by `port.pipelines.get`. */
export type StoredPipelineSource = 'bundled' | 'user' | 'curated';

/**
 * Everything needed to address a single pipeline document, independent of the
 * `PipelineInfo` row it was derived from. Mirrors the locator fields on
 * `PipelineEditorRequest` so the editor can pass its own request through
 * unchanged.
 */
export interface PipelineDocumentLocator {
  pipelineId: string | null;
  cwd?: string;
  pipelineFilePath?: string;
  pipelineSource?: StoredPipelineSource;
  sharedRemoteId?: string;
}

/**
 * Discriminated load outcome. Callers narrow on the `error` key rather than
 * receiving `null` plus a separate message, so a failure always carries text
 * that can be surfaced in a `Notice`.
 */
export type PipelineDocumentResult =
  | { data: PipelineData; error?: undefined }
  | { data?: undefined; error: string };

export interface AutomationPipelineWorktree {
  projectId: string;
  worktreeId: string;
  repoId?: string;
}

export type AutomationPipelineDocumentResult = PipelineDocumentResult & {
  /** Effective worktree used to load a project pipeline, including fallback. */
  worktree?: AutomationPipelineWorktree;
};

const DEFAULT_LOAD_ERROR = 'Failed to load workflow';

/**
 * Build a renderer-shaped `PipelineData` from a `SharedPipelineDetail`
 * fetched from the configured Canopy Cloud backend. The shared id is the
 * canonical `shared:canopy-cloud:${remoteId}` form so downstream consumers
 * can match it against `PipelineInfo.id`.
 */
export function sharedDetailToPipelineData(
  detail: SharedPipelineDetail,
): PipelineData {
  return {
    info: sharedDetailToPipelineInfo(detail),
    content: parsePipelineText(detail.rawPipeline),
  };
}

/** The row of {@link sharedDetailToPipelineData}, without parsing the document. */
export function sharedDetailToPipelineInfo(
  detail: Omit<SharedPipelineDetail, 'rawPipeline'>,
): PipelineInfo {
  return {
    id: `shared:${CANOPY_CLOUD_SERVER_ID}:${detail.id}`,
    name: detail.name,
    filename: '',
    description: detail.description,
    icon: detail.icon,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    triggerTypes: detail.triggerTypes,
    source: 'shared',
    readonly: !detail.canUpdate,
    serverId: CANOPY_CLOUD_SERVER_ID,
    remoteId: detail.id,
    canUpdate: detail.canUpdate,
    canDelete: detail.canDelete,
    // Preserve scope/owner from the server response. Older Canopy Cloud
    // backends (pre `organizations-v1` / `teams-v1`) may omit these fields;
    // default `shareScope` to `'private'` and leave `owner` undefined so the
    // editor renders without throwing.
    shareScope: detail.shareScope ?? 'private',
    ...(detail.owner ? { owner: detail.owner } : {}),
    publicShare: detail.publicShare ?? null,
  };
}

/**
 * Map a `PipelineInfo` row into the locator its source requires. Project rows
 * need the worktree `cwd` plus the on-disk `filePath`; shared rows are
 * addressed by `remoteId`; user/bundled/curated rows carry their namespace so
 * the bare-id lookup (which resolves user-before-bundled) cannot pick the
 * wrong pipeline.
 */
export function pipelineInfoToDocumentLocator(
  info: PipelineInfo,
  cwd?: string,
): PipelineDocumentLocator {
  const pipelineSource: StoredPipelineSource | undefined =
    info.source === 'bundled' ||
    info.source === 'user' ||
    info.source === 'curated'
      ? info.source
      : undefined;
  return {
    pipelineId: info.id,
    cwd: info.source === 'project' ? cwd : undefined,
    pipelineFilePath: info.source === 'project' ? info.filePath : undefined,
    pipelineSource,
    sharedRemoteId: info.source === 'shared' ? info.remoteId : undefined,
  };
}

/**
 * Load the local pipeline referenced by a scheduled automation.
 *
 * User pipelines resolve through the stored catalog. Project pipelines first
 * resolve their worktree cwd and discovery row, then use the same
 * `pipelineInfoToDocumentLocator` → `loadPipelineDocument` path as the
 * Pipelines page. This keeps project `cwd` + `filePath` addressing intact.
 */
export async function loadAutomationPipelineDocument(
  port: PipelineReadPort,
  action: Extract<AutomationAction, { type: 'worktree_pipeline' }>,
): Promise<AutomationPipelineDocumentResult> {
  if (action.pipelineSource === 'user') {
    const listed = await port.pipelines.list();
    const info = listed.data?.find(
      (candidate) =>
        candidate.source === 'user' && candidate.id === action.pipelineId,
    );
    return info
      ? loadPipelineDocument(port, pipelineInfoToDocumentLocator(info))
      : { error: 'Workflow not found' };
  }
  const workspaceId = pipelineAutomationWorkspaceId(action);
  const taskId = pipelineAutomationTaskId(action);
  // The checkout project pipelines are discovered in: the base worktree of a
  // fresh-worktree run, or the existing task of a task run on a code project.
  let checkoutWorktreeId = action.baseWorktreeId;
  if (action.pipelineSource === 'project' && workspaceId) {
    let cwd: string | undefined;
    if (checkoutWorktreeId) {
      cwd = await port.api.getWorktreePath({
        projectId: workspaceId,
        worktreeId: checkoutWorktreeId,
        ...(action.repoId ? { repoId: action.repoId } : {}),
      });
    } else {
      const project = (await port.api.loadProjects()).items.find(
        (candidate) => candidate.id === workspaceId,
      );
      if (project?.type === 'cowork') {
        // A cowork task (Work Entry) runs at the cowork root too.
        cwd = await port.api.getWorktreePath({
          projectId: project.id,
          worktreeId: COWORK_HOME_WORKTREE_ID,
        });
      } else if (project && taskId) {
        checkoutWorktreeId = taskId;
        cwd = await port.api.getWorktreePath({
          projectId: project.id,
          worktreeId: taskId,
          ...(action.repoId ? { repoId: action.repoId } : {}),
        });
      } else if (project?.type === 'single-repo') {
        cwd = project.repoPath;
      } else if (project?.type === 'multi-repo') {
        if (action.repoId && action.repoId !== WORKSPACE_ROOT_REPO_ID)
          cwd = project.repos.find(
            (repo) => repo.id === action.repoId,
          )?.repoPath;
        else if (action.target?.kind === 'project')
          // A project-folder run uses the configured source folder, as main
          // does, not the reference checkout it may be a linked worktree of.
          cwd = project.sourceRepoPath;
        else
          cwd = (
            await port.api.getWorkspaceSettingsData({
              workspaceId: project.id,
            })
          ).referenceRepoPath;
      }
    }
    if (!cwd)
      return { error: 'Workflow cannot be read from this automation target' };
    const discovered = await port.pipelines.discoverProject(cwd);
    if (!discovered.success) return { error: DEFAULT_LOAD_ERROR };
    const matches = discovered.data?.filter(
      (candidate) =>
        candidate.id === action.pipelineId ||
        (action.projectPipelineFilename !== undefined &&
          candidate.filename === action.projectPipelineFilename),
    );
    const info = matches?.length === 1 ? matches[0] : undefined;
    if (!info) return { error: 'Workflow not found' };
    const result = await loadPipelineDocument(
      port,
      pipelineInfoToDocumentLocator(info, cwd),
    );
    return result.data
      ? {
          ...result,
          ...(checkoutWorktreeId !== undefined
            ? {
                worktree: {
                  projectId: workspaceId,
                  worktreeId: checkoutWorktreeId,
                  ...(action.repoId ? { repoId: action.repoId } : {}),
                },
              }
            : {}),
        }
      : result;
  }
  return { error: 'Workflow cannot be read from this automation target' };
}

/**
 * The checkout-relative POSIX path of `filePath`, or `null` when it is not
 * inside `cwd`. Host paths stay in the renderer; main re-checks containment
 * for anything that leaves it.
 */
export function projectPipelineRelativePath(
  cwd: string,
  filePath: string,
): string | null {
  const normalize = (value: string): string =>
    value.replace(/\\/g, '/').replace(/\/+$/, '');
  const root = normalize(cwd);
  const file = normalize(filePath);
  if (!root || !file.startsWith(`${root}/`)) return null;
  const relative = file.slice(root.length + 1);
  if (
    relative
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..')
  ) {
    return null;
  }
  return relative;
}

/**
 * Load the saved pipeline a chat tile's Share points at (CAN-3488). It
 * resolves the item as it is now: a missing pipeline, an unavailable worktree,
 * or a project file that moved is an error, never another pipeline.
 */
export async function loadPipelineShareTargetDocument(
  port: PipelineReadPort,
  target: PipelineRepairShareTarget,
): Promise<AutomationPipelineDocumentResult> {
  try {
    if (target.source === 'stored') {
      const listed = await port.pipelines.list();
      if (!listed.success) return { error: DEFAULT_LOAD_ERROR };
      const matches = listed.data?.filter(
        (candidate) =>
          candidate.source === 'user' && candidate.id === target.pipelineId,
      );
      const info = matches?.length === 1 ? matches[0] : undefined;
      return info
        ? await loadPipelineDocument(port, pipelineInfoToDocumentLocator(info))
        : { error: 'Workflow not found' };
    }
    const worktree: AutomationPipelineWorktree = {
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      ...(target.repoId ? { repoId: target.repoId } : {}),
    };
    const cwd = await port.api.getWorktreePath(worktree);
    if (!cwd) return { error: "This workflow's worktree is unavailable" };
    const discovered = await port.pipelines.discoverProject(cwd);
    const info = discovered.data?.find(
      (candidate) =>
        candidate.source === 'project' &&
        candidate.id === target.pipelineId &&
        candidate.filePath !== undefined &&
        projectPipelineRelativePath(cwd, candidate.filePath) ===
          target.relativePath,
    );
    if (!info) return { error: 'Workflow not found' };
    const result = await loadPipelineDocument(
      port,
      pipelineInfoToDocumentLocator(info, cwd),
    );
    return result.data ? { ...result, worktree } : result;
  } catch (error: unknown) {
    return {
      error: error instanceof Error ? error.message : DEFAULT_LOAD_ERROR,
    };
  }
}

/**
 * Load a pipeline document for an already-resolved locator. Never throws for
 * an IPC-level failure: the handler's typed error (for example "Canopy Cloud
 * account is not configured" when the API key was removed mid-session) is
 * returned as `{ error }`, and so is a rejected `invoke` — `registerIpcHandler`
 * rejects rather than returning `{ success: false }` when a main-process
 * handler throws. Callers therefore only have to narrow on `error`; they do not
 * need their own try/catch.
 */
export async function loadPipelineDocument(
  port: PipelineReadPort,
  locator: PipelineDocumentLocator,
): Promise<PipelineDocumentResult> {
  try {
    return await invokePipelineDocumentLoad(port, locator);
  } catch (error: unknown) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function invokePipelineDocumentLoad(
  port: PipelineReadPort,
  locator: PipelineDocumentLocator,
): Promise<PipelineDocumentResult> {
  const { pipelineId, cwd, pipelineFilePath, pipelineSource, sharedRemoteId } =
    locator;

  if (sharedRemoteId) {
    // Load via the dedicated shared-get IPC. The handler will return a typed
    // "Canopy Cloud account is not configured" error if the user removed the
    // API key while the editor was open.
    const result = await port.pipelines.getShared({
      remoteId: sharedRemoteId,
    });
    if (!result.success || !result.data) {
      return { error: result.error ?? DEFAULT_LOAD_ERROR };
    }
    return { data: sharedDetailToPipelineData(result.data) };
  }

  if (pipelineId === null) {
    return { error: 'Workflow id is required to load this workflow' };
  }

  const result =
    cwd && pipelineFilePath
      ? await port.pipelines.get({
          id: pipelineId,
          cwd,
          filePath: pipelineFilePath,
        })
      : pipelineSource
        ? await port.pipelines.get({
            id: pipelineId,
            source: pipelineSource,
          })
        : await port.pipelines.get(pipelineId);

  if (!result.success || !result.data) {
    return { error: result.error ?? DEFAULT_LOAD_ERROR };
  }
  return { data: result.data };
}

/**
 * Convenience wrapper for list surfaces that hold a `PipelineInfo` row: derive
 * the locator, then load. `cwd` is the selected worktree directory and is only
 * consulted for `source === 'project'` rows.
 */
export async function fetchPipelineDocument(
  port: PipelineReadPort,
  info: PipelineInfo,
  cwd?: string,
): Promise<PipelineDocumentResult> {
  if (info.source === 'shared' && !info.remoteId) {
    // Without a remoteId the locator falls through to the bare-id lookup,
    // which resolves against the local stored catalog and fails with an
    // opaque "not found". Name the real problem instead — `handleRowDelete`
    // guards the same case.
    return { error: 'This shared workflow is missing its remote id' };
  }
  return loadPipelineDocument(port, pipelineInfoToDocumentLocator(info, cwd));
}
