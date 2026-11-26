import {
  IPC_CHANNELS,
  type CoworkWorkEntryCreateRequest,
  type CoworkWorkEntryCreateResponse,
  type CoworkWorkEntryDeleteRequest,
  type CoworkWorkEntryDeleteResponse,
  type CoworkWorkEntryListRequest,
  type CoworkWorkEntryListResponse,
  type CoworkWorkEntryReorderRequest,
  type CoworkWorkEntryResolveChatRequest,
  type CoworkWorkEntryResolveChatResponse,
  type CoworkWorkEntryUpdateRequest,
} from '@canopy/desktop-shared/types';
import { isBotProjectId } from '@canopy/protocol/chat-targets';
import { getActiveChatIds } from '../agents/session-manager';
import {
  createWorkEntry,
  listWorkEntries,
  onWorkEntryListChanged,
  reorderWorkEntries,
} from '../lib/cowork-work-entries';
import { validateId } from '../lib/validation';
import { assertWritableScope } from '../lib/read-only-scope';
import { getActiveDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { preserveRuntimeCauseError } from '../canopy-runtime/runtime-cause-error';
import { registerIpcHandler } from './register';
import {
  assertWorkEntryWorkspace,
  deleteWorkEntryMutation,
  updateWorkEntryMutation,
} from '../lib/work-entry-mutations';

export { assertWorkEntryWorkspace };

let stopWorkEntryListProjection: (() => void) | null = null;

/**
 * Creating, deleting, restoring or reordering a Work Entry shifts every
 * sibling's registry index, so stale the desktop session snapshot for the
 * whole cowork workspace.
 */
function projectWorkEntryListChanges(workspaceId: string): void {
  if (isBotProjectId(workspaceId)) return;
  // Keep the large standalone-chat service graph off Electron startup, as the
  // handlers below do; the projection is only needed once an entry changes.
  void import('../services/standalone-chat-service')
    .then(({ emitStandaloneWorkspaceWorkEntrySummaries }) =>
      emitStandaloneWorkspaceWorkEntrySummaries(),
    )
    .catch(() => undefined);
}

export function registerWorkEntryHandlers(): void {
  stopWorkEntryListProjection?.();
  stopWorkEntryListProjection = onWorkEntryListChanged(
    projectWorkEntryListChanges,
  );
  registerIpcHandler<[CoworkWorkEntryListRequest], CoworkWorkEntryListResponse>(
    IPC_CHANNELS.workEntriesList,
    async (_event, request) => {
      const workspaceId = assertWorkEntryWorkspace(request.projectId);
      // Live session lookup injected here (not statically imported by the
      // registry lib) so hasActiveChat reflects in-flight turns at list time.
      return {
        entries: await listWorkEntries(workspaceId, { getActiveChatIds }),
      };
    },
  );

  registerIpcHandler<
    [CoworkWorkEntryCreateRequest],
    CoworkWorkEntryCreateResponse
  >(IPC_CHANNELS.workEntriesCreate, async (_event, request) => {
    const workspaceId = assertWorkEntryWorkspace(request.projectId);
    return createWorkEntry(workspaceId, {
      ...(request.sidebarItemGroupId === undefined
        ? {}
        : { sidebarItemGroupId: request.sidebarItemGroupId }),
      ...(request.title !== undefined ? { title: request.title } : {}),
    });
  });

  registerIpcHandler<[CoworkWorkEntryUpdateRequest], void>(
    IPC_CHANNELS.workEntriesUpdate,
    async (_event, request) => updateWorkEntryMutation(request),
  );

  registerIpcHandler<[CoworkWorkEntryReorderRequest], void>(
    IPC_CHANNELS.workEntriesReorder,
    async (_event, request) => {
      const workspaceId = assertWorkEntryWorkspace(request.projectId);
      request.entryIds.forEach((entryId) => validateId(entryId, 'entryId'));
      await reorderWorkEntries(workspaceId, request.entryIds);
    },
  );

  registerIpcHandler<
    [CoworkWorkEntryDeleteRequest],
    CoworkWorkEntryDeleteResponse
  >(IPC_CHANNELS.workEntriesDelete, async (_event, request) => {
    // A read-only scope deletes nothing, for every caller (CAN-7446).
    assertWritableScope(request.projectId);
    return deleteWorkEntryMutation(request);
  });

  registerIpcHandler<
    [CoworkWorkEntryResolveChatRequest],
    CoworkWorkEntryResolveChatResponse
  >(IPC_CHANNELS.workEntriesResolveChat, async (_event, request) => {
    const workspaceId = assertWorkEntryWorkspace(request.projectId);
    validateId(request.chatId, 'chatId');
    const located = await preserveRuntimeCauseError(
      getActiveDesktopRuntime().query(
        'core.chat.locate',
        { scope: { workspaceId }, chatId: request.chatId },
        {
          caller: {
            principalId: 'local-desktop-user',
            clientInstanceId: 'desktop-main-work-entries',
            authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
            interfaceKind: 'desktop',
            grants: ['core.chat.read'],
          },
        },
      ),
    );
    return {
      entryId: located.worktreeId,
      archivedInEntryId: located.archivedInWorktreeId,
    };
  });
}
