import {
  CoreWorkspaceRepositorySchema,
  CoreWorkspaceUpdateResultSchema,
  type CoreWorkspaceRepository,
  type CoreWorkspaceUpdateResult,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../../runtime/errors';
import {
  projectCoreWorkspace,
  sanitizeRemoteUrl,
} from '../../workspace/core-workspace-projection';
import { w5CoreWorkspaceManifestRead } from '../../workspace/core-workspace-w5-reads';
import type { StoredWorkspaceIndexRepository } from '../workspace-index-repository';
import type { WorkspaceManifestRead } from '../workspace-manifest-repository';
import type { W5ManifestRepositoryView } from './ports';

/*
 * The daemon's `core.workspace.update` result (W7a-3, DM-2): the
 * `core.workspace.get` projection of the workspace as the decision left it,
 * from the daemon's own W5 reads, with the shared projection's typed-field
 * rules (`core-workspace-projection.ts`). It has no `revision`, timestamps or
 * source-config overlay: `repositorySources` are the stored repositories'
 * remote URLs only (debt before W15 or a daemon `core.workspace.get`).
 */

/** The reads the projection makes; inside a decision they see its staging. */
export interface W5DecidedWorkspaceReads {
  readonly index: Pick<StoredWorkspaceIndexRepository, 'readStored'>;
  readManifest(workspaceId: string): Promise<WorkspaceManifestRead>;
}

/** A stored repository without its path; an unsanitizable URL is omitted. */
export function projectW5Repository(
  repository: Pick<
    W5ManifestRepositoryView,
    'id' | 'name' | 'source' | 'manifestUrl'
  >,
): CoreWorkspaceRepository {
  const url = sanitizeRemoteUrl(repository.manifestUrl);
  const manifestUrl =
    url !== null &&
    CoreWorkspaceRepositorySchema.shape.manifestUrl.safeParse(url).success
      ? url
      : undefined;
  return {
    id: repository.id,
    name: repository.name,
    ...(repository.source !== undefined && { source: repository.source }),
    ...(manifestUrl !== undefined && { manifestUrl }),
  };
}

/*
 * Well under one transport frame: a stored value no request could send (a
 * repository name or remote above a frame) would otherwise commit a decision
 * whose result, and every replay of it, never arrives.
 */
const RESULT_BYTES_MAX = 1024 * 1024;

/** `result`, or `result-unavailable` when it could not be delivered. */
export function deliverableW5Result<T>(result: T): T {
  if (Buffer.byteLength(JSON.stringify(result)) > RESULT_BYTES_MAX)
    throw resultUnavailable();
  return result;
}

function resultUnavailable(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'capability_unavailable',
    message:
      "This project's details can't be returned here, so nothing was changed.",
    details: { reason: 'result-unavailable' },
    retry: { kind: 'never' },
  });
}

/**
 * The workspace's #3 result as `reads` see it. A workspace the result cannot
 * carry (a stored name over 256 characters, a missing or duplicate index row,
 * a result above the delivery bound) is `capability_unavailable`
 * (`result-unavailable`); a stored repository id over 512 characters is
 * `invalid_argument`, as the desktop projection refuses it.
 */
export async function readW5DecidedWorkspace(
  reads: W5DecidedWorkspaceReads,
  workspaceId: string,
): Promise<CoreWorkspaceUpdateResult> {
  const snapshot = await reads.index.readStored();
  const rows = snapshot.entries.flatMap((entry, at) =>
    entry.id === workspaceId ? [at] : [],
  );
  const [at] = rows;
  const entry = at === undefined ? undefined : snapshot.entries[at];
  if (rows.length !== 1 || at === undefined || !entry)
    throw resultUnavailable();
  const manifest = w5CoreWorkspaceManifestRead(
    await reads.readManifest(workspaceId),
  );
  const result = CoreWorkspaceUpdateResultSchema.safeParse(
    projectCoreWorkspace({
      index: entry,
      indexStored: snapshot.storedFields[at],
      repositories: manifest.repositories,
      ...(manifest.authority === 'ok' && {
        manifest: { fields: manifest.fields, stored: manifest.stored },
      }),
    }),
  );
  if (!result.success) throw resultUnavailable();
  return deliverableW5Result(result.data);
}

/**
 * The decision's hook: a read failure refuses before the decision, so the
 * key is released and no committed change goes unanswered.
 */
export async function decideW5Workspace(
  reads: W5DecidedWorkspaceReads,
  workspaceId: string,
): Promise<CoreWorkspaceUpdateResult> {
  try {
    return await readW5DecidedWorkspace(reads, workspaceId);
  } catch (error) {
    if (error instanceof CanopyOperationError) throw error;
    throw new CanopyOperationError(
      {
        kind: 'unavailable',
        message:
          "This project's details couldn't be read, so nothing was changed. Try again.",
        retry: { kind: 'same_idempotency_key' },
      },
      error,
    );
  }
}
