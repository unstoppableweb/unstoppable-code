/**
 * A cowork project's archived and deleted Work Entries over IPC (CAN-5986):
 * the read Portal's `portal.workspace.archived_work_entries.list` served, for
 * controllers that reach this computer without Portal, such as a browser over
 * direct Remote Control.
 *
 * The read is the same one Portal's adapter made, which now calls
 * {@link readArchivedWorkEntries} too. Who may call it is the caller's
 * concern: over Remote Control the host admits only controllers whose profile
 * lists `work-entries:list-archived` (desktop and browser; mobile and hosted
 * are refused before this runs), and Portal keeps its own pairing check.
 * Nothing is written: manifests and the legacy chat registry are read only.
 */
import type {
  PortalArchivedWorkEntriesListResult,
  PortalArchivedWorkEntry,
} from '@canopy/protocol/portal';
import { CHAT_UNIT_LABEL } from '@canopy/protocol';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { isArchivedContainerExpired } from '@canopy/desktop-shared/lib/archive-retention';
import { chatDisplayLabel } from '@canopy/desktop-shared/lib/chat-display-label';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { IdentifierValidationError, validateId } from '../lib/validation';
import { PortalServiceError } from '../services/portal-service-error';
import { registerIpcHandler } from './register';

/** The tunnel frame budget an archive overview stays inside. */
export const ARCHIVED_WORK_ENTRIES_MAX_BYTES = 256 * 1024;

const LOAD_FAILED = "Couldn't load archived and deleted items.";

/** The caller lost its authorization while the read ran. */
export class ArchivedWorkEntriesForbiddenError extends Error {
  public readonly code = 'forbidden';
  public constructor() {
    super('The paired session cannot list archives.');
    this.name = 'ArchivedWorkEntriesForbiddenError';
  }
}

export interface ArchivedWorkEntriesListRequest {
  readonly projectLocalId: string;
  /** Only the first page exists; any other offset is refused. */
  readonly offset?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The request's project, or a typed `invalid_payload` refusal. */
export function readArchivedWorkEntriesRequest(
  request: unknown,
): ArchivedWorkEntriesListRequest {
  if (
    !isRecord(request) ||
    typeof request.projectLocalId !== 'string' ||
    (request.offset !== undefined && request.offset !== 0)
  ) {
    throw new PortalServiceError(
      'invalid_payload',
      'A matching project is required.',
    );
  }
  try {
    validateId(request.projectLocalId, 'projectLocalId');
  } catch (error) {
    if (error instanceof IdentifierValidationError)
      throw new PortalServiceError('invalid_payload', error.message);
    throw error;
  }
  return { projectLocalId: request.projectLocalId };
}

/**
 * The project's archived and deleted Work Entries (unexpired manifests) and
 * its legacy archived chats, newest state first as the manifests list them.
 *
 * Typed refusals: `not_found` for a project this computer does not list,
 * `forbidden` ({@link ArchivedWorkEntriesForbiddenError}) when
 * `stillAuthorized` turns false while the read runs, and `execution_failed`
 * with fixed, path-free copy for anything else (the cause stays in desktop
 * logs). A result above {@link ARCHIVED_WORK_ENTRIES_MAX_BYTES} is refused,
 * never truncated.
 */
export async function readArchivedWorkEntries(
  projectLocalId: string,
  stillAuthorized: () => boolean = () => true,
): Promise<PortalArchivedWorkEntriesListResult> {
  // Throws IdentifierValidationError; the IPC handler has already refused an
  // invalid ID as invalid_payload, and Portal's adapter maps it as before.
  validateId(projectLocalId, 'projectLocalId');
  let result: PortalArchivedWorkEntriesListResult;
  try {
    const { listCoworkWorkspacesAsChatProjects } =
      await import('../lib/cowork-workspace-crud');
    const projectId = resolveCoworkWorkspaceId(projectLocalId);
    const { readAllSidebarItemsSnapshot } =
      await import('../lib/sidebar-items');
    const sidebar = await readAllSidebarItemsSnapshot({
      persistRemovalCleanup: false,
    });
    const projects = await listCoworkWorkspacesAsChatProjects(sidebar, {
      provisionDefaults: false,
    });
    if (!projects.some((project) => project.id === projectId)) {
      throw new PortalServiceError(
        'not_found',
        'The cowork project is unavailable.',
      );
    }
    const { listArchivedContainerManifests } =
      await import('../lib/archived-containers');
    const { listChats } = await import('./standalone-chat');
    const [manifests, legacy] = await Promise.all([
      listArchivedContainerManifests(projectId),
      listChats(projectId, { readOnly: true }),
    ]);
    if (!stillAuthorized()) throw new ArchivedWorkEntriesForbiddenError();
    const now = Date.now();
    const items: PortalArchivedWorkEntry[] = [];
    for (const manifest of manifests) {
      if (
        manifest.kind !== 'work-entry' ||
        isArchivedContainerExpired(manifest, now)
      )
        continue;
      items.push({
        id: manifest.id,
        title: manifest.name.slice(0, 512),
        state: manifest.lockedAt === undefined ? 'deleted' : 'archived',
        archivedAt: manifest.lockedAt ?? manifest.archivedAt,
        expiresAt: manifest.expiresAt,
      });
    }
    for (const chat of legacy.chats) {
      if (chat.archived !== true) continue;
      items.push({
        id: chat.id,
        title: chatDisplayLabel({
          customTitle: chat.customTitle,
          title: chat.title,
          description: chat.description,
          fallback: `New ${CHAT_UNIT_LABEL}`,
        }).slice(0, 512),
        state: 'archived',
        archivedAt: chat.archivedAt ?? chat.lastMessageAt ?? chat.createdAt,
        legacyChat: true,
      });
    }
    result = { items, nextOffset: null };
    if (
      Buffer.byteLength(JSON.stringify(result), 'utf8') >
      ARCHIVED_WORK_ENTRIES_MAX_BYTES
    ) {
      throw new Error('Archive overview result exceeded its size budget');
    }
  } catch (error) {
    if (
      error instanceof PortalServiceError ||
      error instanceof ArchivedWorkEntriesForbiddenError
    )
      throw error;
    logMainProcessWarn('Archived Work Entry list failed', { error });
    throw new PortalServiceError('execution_failed', LOAD_FAILED);
  }
  return result;
}

export function registerArchivedWorkEntryHandlers(): void {
  registerIpcHandler<[unknown], PortalArchivedWorkEntriesListResult>(
    IPC_CHANNELS.workEntriesListArchived,
    async (_event, request) =>
      readArchivedWorkEntries(
        readArchivedWorkEntriesRequest(request).projectLocalId,
      ),
  );
}
