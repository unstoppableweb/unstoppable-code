import {
  CanopyOperationError,
  type CanopyHandlerContext,
} from '@canopy/core-runtime';
import type {
  ArchiveContainerSummary,
  ArchiveChatGetResult,
} from '@canopy/protocol/canopy-core';
import { KeyedOutcomes } from '@canopy/core-runtime/node/operations';
import { sanitizePersistedChatMessages } from '@canopy/agent-transcript/lib/message-sanitization';
import { serializeLegacyChatHistoryMessage } from '@canopy/desktop-shared/lib/chat-history-serialization';
import type {
  ArchivedContainerSummary,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import { validateId } from '../lib/validation';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';
import type { DesktopDomainAdapter } from './desktop-runtime';

/** The archive owners behind `core.archive.*`; tests inject them. */
export interface CoreArchiveHost {
  list(workspaceId: string): Promise<ArchivedContainerSummary[]>;
  /** The project's name, or null when the index has no such project. */
  workspaceName(workspaceId: string): Promise<string | null>;
  /** The chat among the container's chats and archived chats, or null. */
  readChat(
    workspaceId: string,
    archiveId: string,
    chatId: string,
  ): Promise<PersistedChatTab | null>;
  setLocked(
    workspaceId: string,
    archiveId: string,
    locked: boolean,
  ): Promise<ArchivedContainerSummary>;
}

const desktopArchiveHost: CoreArchiveHost = {
  list: async (workspaceId) =>
    (await import('../lib/archived-containers')).listArchivedContainers(
      workspaceId,
    ),
  workspaceName: async (workspaceId) =>
    (
      await (
        await import('../lib/sidebar-items')
      ).readWorkspaceIndexEntry(workspaceId)
    )?.name ?? null,
  readChat: async (workspaceId, archiveId, chatId) => {
    const { readArchivedContainerChats, readArchivedContainerChatArchives } =
      await import('../lib/archived-containers');
    const [chats, archives] = await Promise.all([
      readArchivedContainerChats(workspaceId, archiveId, {
        chatIds: [chatId],
        pageOnly: true,
      }),
      readArchivedContainerChatArchives(workspaceId, archiveId, {
        chatIds: [chatId],
        pageOnly: true,
      }),
    ]);
    return (
      chats.tabs.find((tab) => tab.id === chatId) ??
      archives.archived.find((entry) => entry.tab.id === chatId)?.tab ??
      null
    );
  },
  setLocked: async (workspaceId, archiveId, locked) =>
    (await import('../lib/archived-containers')).setArchivedContainerLocked(
      workspaceId,
      archiveId,
      locked,
    ),
};

function notFound(
  code: 'core.archive.container.notFound' | 'core.archive.chat.notFound',
  message: string,
): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'not_found',
    message,
    code,
    retry: { kind: 'never' },
  });
}

/** Only this desktop's own callers read or lock its archive. */
function ownAuthority(context: CanopyHandlerContext): void {
  if (context.caller.authorityId !== LOCAL_DESKTOP_AUTHORITY_ID)
    throw new CanopyOperationError({
      kind: 'permission_denied',
      message: "Only this desktop's own archive answers.",
      code: 'core.archive.foreignAuthority',
      retry: { kind: 'never' },
    });
}

/** A field only the web core serves (CAN-6109), refused before any read. */
function notServed(field: string, message: string): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'capability_unavailable',
    message,
    details: { unsupported: [field] },
    retry: { kind: 'never' },
  });
}

function validWorkspaceId(workspaceId: string | undefined): string {
  if (workspaceId === undefined)
    throw notServed('workspaceId', 'This desktop lists one project at a time.');
  try {
    validateId(workspaceId, 'workspaceId');
  } catch {
    throw new CanopyOperationError({
      kind: 'invalid_argument',
      message: 'Not a valid project id.',
      code: 'core.archive.workspace.invalid',
      retry: { kind: 'never' },
    });
  }
  return workspaceId;
}

/** Its project's name, or its id when the index no longer has it. */
async function nameOf(
  host: CoreArchiveHost,
  workspaceId: string,
): Promise<string> {
  return (await host.workspaceName(workspaceId)) ?? workspaceId;
}

export function toArchiveContainerSummary(
  container: ArchivedContainerSummary,
  workspaceId: string,
  workspaceName: string,
): ArchiveContainerSummary {
  return {
    archiveId: container.id,
    kind: container.kind,
    workspaceId,
    workspaceName,
    // Electron main keeps no per-container revision.
    revision: null,
    name: container.name,
    branchName: container.branchName ?? null,
    archivedAt: container.archivedAt,
    expiresAt: container.expiresAt,
    locked: container.lockedAt !== undefined,
    lockedAt: container.lockedAt ?? null,
    chatCount: container.chatCount,
    archivedChatCount: container.archivedChatCount,
    executionCount: container.executionCount,
    partiallyRestored: container.restoredTo !== undefined,
  };
}

/** The project's live container, or not_found: never another project's. */
async function containerOf(
  host: CoreArchiveHost,
  workspaceId: string,
  archiveId: string,
): Promise<ArchivedContainerSummary> {
  const container = (await host.list(validWorkspaceId(workspaceId))).find(
    (entry) => entry.id === archiveId,
  );
  if (!container)
    throw notFound(
      'core.archive.container.notFound',
      `Archived container ${archiveId} was not found in project ${workspaceId}.`,
    );
  return container;
}

/**
 * `core.archive.container.list`, `core.archive.chat.get` and
 * `core.archive.container.update` on the desktop dispatcher (CAN-6007), over
 * the owners the window's archive handlers call.
 */
export function createCoreArchiveAdapter(
  host: CoreArchiveHost = desktopArchiveHost,
): DesktopDomainAdapter {
  const updates = new KeyedOutcomes<{ container: ArchiveContainerSummary }>({
    reusedError: (): CanopyOperationError =>
      new CanopyOperationError({
        kind: 'conflict',
        message: 'This idempotency key was used with other parameters.',
        retry: { kind: 'never' },
      }),
  });
  return {
    queries: {
      'core.archive.container.list': async (params, context) => {
        ownAuthority(context);
        const workspaceId = validWorkspaceId(params.workspaceId);
        const [containers, workspaceName] = await Promise.all([
          host.list(workspaceId),
          nameOf(host, workspaceId),
        ]);
        return {
          workspaceId,
          containers: containers.map((container) =>
            toArchiveContainerSummary(container, workspaceId, workspaceName),
          ),
        };
      },
      'core.archive.chat.get': async (
        params,
        context,
      ): Promise<ArchiveChatGetResult> => {
        ownAuthority(context);
        await containerOf(host, params.workspaceId, params.archiveId);
        const tab = await host.readChat(
          params.workspaceId,
          params.archiveId,
          params.chatId,
        );
        if (!tab)
          throw notFound(
            'core.archive.chat.notFound',
            `Archived chat ${params.chatId} was not found.`,
          );
        const messages = sanitizePersistedChatMessages(tab.messages);
        return {
          workspaceId: params.workspaceId,
          archiveId: params.archiveId,
          chatId: params.chatId,
          title: tab.title ?? null,
          totalMessages: messages.length,
          messages: messages
            .slice(-params.limit)
            .map(serializeLegacyChatHistoryMessage),
        };
      },
    },
    instructions: {
      'core.archive.container.update': (params, context) => {
        ownAuthority(context);
        if (params.expectedRevision !== undefined)
          throw notServed(
            'expectedRevision',
            'This desktop keeps no revision per archived container.',
          );
        return updates.run(context, params, async () => {
          await containerOf(host, params.workspaceId, params.archiveId);
          return {
            container: toArchiveContainerSummary(
              await host.setLocked(
                params.workspaceId,
                params.archiveId,
                params.locked,
              ),
              params.workspaceId,
              await nameOf(host, params.workspaceId),
            ),
          };
        });
      },
    },
  };
}
