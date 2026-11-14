import { CoreArtifactListResultSchema } from '@canopy/protocol/canopy-core';
import type { z } from 'zod';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import type { CanopyCoreRelayApi } from '../../../shared/canopy-core-relay';
import { requestWebCore } from '@/lib/files/web-core-file-source';
import { CoreCoworkRequestError } from '@canopy/app-state/core-cowork';
import { webCoreLocalId } from '@/lib/chat-authority';

/*
 * A cloud project's shared workspace files for the activity rail (CAN-6568):
 * listed with `core.artifact.list` (owner `workspace`) over the web core
 * relay, by the project's web core id. Read here, outside the section, so the
 * rail knows whether there is anything to show before the section mounts.
 */

export interface CloudWorkspaceFileRow {
  readonly id: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
}

export type CloudWorkspaceFileList =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  /** The web core serves no workspace files for this project. */
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'ready'; readonly rows: readonly CloudWorkspaceFileRow[] };

type ListResult = z.output<typeof CoreArtifactListResultSchema>;

const PAGE_LIMIT = 100;
const MAX_PAGES = 10;

const lists = new Map<string, CloudWorkspaceFileList>();
/** The newest read of each project, so an older answer never replaces it. */
const reads = new Map<string, number>();
const listeners = new Set<() => void>();
let readCount = 0;

function publish(workspaceId: string, list: CloudWorkspaceFileList): void {
  lists.set(workspaceId, list);
  for (const listener of listeners) listener();
}

/** A project's workspace files as last read, or undefined before the first. */
export function cloudWorkspaceFileList(
  workspaceId: string,
): CloudWorkspaceFileList | undefined {
  return lists.get(workspaceId);
}

export function subscribeCloudWorkspaceFileLists(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Reads a project's workspace files. The rows already shown stay while it
 * reads; a failed read shows the error until the next one. A web core that
 * serves no workspace files for the project leaves the section out.
 */
export async function refreshCloudWorkspaceFiles(
  relay: CanopyCoreRelayApi,
  workspaceId: string,
): Promise<void> {
  readCount += 1;
  const read = readCount;
  reads.set(workspaceId, read);
  if (lists.get(workspaceId)?.kind !== 'ready')
    publish(workspaceId, { kind: 'loading' });
  try {
    const rows: CloudWorkspaceFileRow[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const listed: ListResult = await requestWebCore(
        relay,
        'core.artifact.list',
        {
          owner: { kind: 'workspace', id: workspaceId },
          kinds: ['file'],
          states: ['available'],
          cursor,
          limit: PAGE_LIMIT,
        },
        CoreArtifactListResultSchema,
      );
      for (const artifact of listed.artifacts) {
        if (artifact.availability !== 'available') continue;
        rows.push({
          id: artifact.artifactId,
          name: artifact.name,
          sizeBytes: artifact.sizeBytes,
          createdAt: artifact.createdAt,
        });
      }
      cursor = listed.nextCursor;
      if (cursor === null) break;
    }
    if (reads.get(workspaceId) === read)
      publish(workspaceId, { kind: 'ready', rows });
  } catch (error) {
    if (reads.get(workspaceId) !== read) return;
    if (
      error instanceof CoreCoworkRequestError &&
      error.payload.kind === 'capability_unavailable'
    ) {
      publish(workspaceId, { kind: 'unavailable' });
      return;
    }
    // The section shows the error with Try again; record why it failed.
    reportClientAppError(error);
    publish(workspaceId, { kind: 'error' });
  }
}

/**
 * Whether the web core said it serves no workspace files for this scope's
 * project: its section is then never offered, restored or mounted.
 */
export function cloudWorkspaceFilesUnavailable(projectId: string): boolean {
  const workspaceId = webCoreLocalId(projectId);
  return workspaceId !== null && lists.get(workspaceId)?.kind === 'unavailable';
}

/** The rail's header for a project's workspace files, from its list. */
export function cloudWorkspaceFilesHeader(
  list: CloudWorkspaceFileList | undefined,
): {
  readonly subtitle: string | undefined;
  readonly collapsedIconColor: 'blue' | 'muted';
  readonly hasContent: boolean;
} {
  const count = list?.kind === 'ready' ? list.rows.length : 0;
  return {
    subtitle:
      count > 0 ? `${count} ${count === 1 ? 'file' : 'files'}` : undefined,
    collapsedIconColor: count > 0 ? 'blue' : 'muted',
    // A failed read keeps the section, so its error and Try again show.
    hasContent: count > 0 || list?.kind === 'error',
  };
}

/** Reads a project's workspace files unless they were read or are being read. */
export function ensureCloudWorkspaceFiles(
  relay: CanopyCoreRelayApi,
  workspaceId: string,
): void {
  if (!lists.has(workspaceId))
    void refreshCloudWorkspaceFiles(relay, workspaceId);
}

/**
 * The project may hold new workspace files: a send landed or a turn ended
 * (CAN-6645). A list this window already read is read again; one it never
 * read waits for its section.
 */
export function cloudWorkspaceFilesChanged(
  relay: CanopyCoreRelayApi,
  workspaceId: string,
): void {
  if (lists.has(workspaceId))
    void refreshCloudWorkspaceFiles(relay, workspaceId);
}
