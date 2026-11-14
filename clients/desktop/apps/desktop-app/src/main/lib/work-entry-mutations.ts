import {
  APP_ADVISOR_PROJECT_ID,
  type CoworkWorkEntryDeleteRequest,
  type CoworkWorkEntryDeleteResponse,
  type CoworkWorkEntryUpdateRequest,
} from '@canopy/desktop-shared/types';
import { updateWorkEntry } from './cowork-work-entries';
import { getTelemetrySyncService } from '../services/telemetry-sync-service';
import { resolveCoworkWorkspaceId } from './cowork-migration-map';
import { isCoworkWorkspace } from './workspace-registry';
import { validateId } from './validation';
import { deleteWorkEntry } from './work-entry-delete';

/** Resolve the workspace accepted by the legacy Work Entry IPC surface. */
export function assertWorkEntryWorkspace(projectId: string): string {
  validateId(projectId, 'projectId');
  // App Advisor is an app-managed Work Entry workspace. It deliberately does
  // not participate in workspaces/index.json, so it must bypass cowork
  // migration and indexed-workspace membership checks at this IPC boundary.
  if (projectId === APP_ADVISOR_PROJECT_ID) {
    return projectId;
  }
  const workspaceId = resolveCoworkWorkspaceId(projectId);
  if (!isCoworkWorkspace(workspaceId)) {
    throw new Error(`Project ${workspaceId} is not a cowork project`);
  }
  return workspaceId;
}

/** Update a Work Entry using the existing main-process IPC lifecycle. */
export async function updateWorkEntryMutation(
  request: CoworkWorkEntryUpdateRequest,
): Promise<void> {
  const workspaceId = assertWorkEntryWorkspace(request.projectId);
  validateId(request.entryId, 'entryId');
  if (
    request.status !== undefined &&
    request.status !== 'active' &&
    request.status !== 'done'
  ) {
    throw new Error(`Invalid work entry status ${String(request.status)}`);
  }
  if (request.pinned !== undefined && typeof request.pinned !== 'boolean') {
    throw new Error('Invalid work entry pinned state');
  }
  await updateWorkEntry(workspaceId, request.entryId, {
    ...(request.title !== undefined ? { title: request.title } : {}),
    ...(request.status !== undefined ? { status: request.status } : {}),
    ...(request.pinned !== undefined ? { pinned: request.pinned } : {}),
  });

  if (workspaceId !== APP_ADVISOR_PROJECT_ID) {
    // Keep the large standalone-chat service graph off Electron startup;
    // work-entry handlers do not need it until cowork projection runs.
    const { emitStandaloneWorkEntrySummary } =
      await import('../services/standalone-chat-service');
    await emitStandaloneWorkEntrySummary(workspaceId, request.entryId);
  }

  // A rename or a mark-done is usually the LAST action on an entry, so no
  // subsequent turn will carry the new metadata to the server. Both feed the
  // Impact delivery track (linkage bonus from a ticket id in the title, done
  // bonus from the status), so push an envelope-only metadata refresh rather
  // than waiting for content that will never arrive. Fire-and-forget: the
  // registry write already succeeded and telemetry must not fail a local edit.
  // No-ops when telemetry sync is off.
  void getTelemetrySyncService()
    .refreshWorktreeMetadata(workspaceId, request.entryId)
    .catch(() => undefined);
  if (workspaceId === APP_ADVISOR_PROJECT_ID) {
    const { projectAppAdvisorChatSummaries } =
      await import('../services/chat-service');
    await projectAppAdvisorChatSummaries(request.entryId);
  }
}

/** Delete a Work Entry using the complete existing fenced IPC lifecycle. */
export async function deleteWorkEntryMutation(
  request: CoworkWorkEntryDeleteRequest,
  options?: {
    /** Remote callers' authorization check: runs right before browser views
     * close and again before teardown; a throw aborts the deletion. */
    authorize?: () => void;
  },
): Promise<CoworkWorkEntryDeleteResponse> {
  const workspaceId = assertWorkEntryWorkspace(request.projectId);
  validateId(request.entryId, 'entryId');
  return deleteWorkEntry({
    workspaceId,
    entryId: request.entryId,
    lockAfterArchive: request.lockAfterArchive,
    ...(options?.authorize ? { beforeTeardown: options.authorize } : {}),
  });
}
