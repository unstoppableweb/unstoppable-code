/**
 * Workspace items store — Notes/Prompts/Attachments backing the shared
 * activity cards (and the @-mention candidate source in ChatInput/Home).
 *
 * Notes and prompts are workspace-global, keyed by `projectId`; attachments
 * are per-worktree, keyed by `${projectId}/${worktreeId}` (mirroring
 * `activityStore`'s keying). Storage differences per workspace type live
 * entirely behind `window.api.workspaceItems` (see
 * `main/ipc/workspace-items.ts`) — this store is storage-agnostic.
 */
import { create } from 'zustand';
import { isWebCoreScope } from '@/lib/chat-authority';
import {
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type ClipboardAttachmentData,
  type WorkspaceAttachmentItem,
  type WorkspaceNoteItem,
  type WorkspacePromptItem,
} from '@canopy/desktop-shared/types';

function attachmentsKey(projectId: string, worktreeId: string): string {
  return `${projectId}/${worktreeId}`;
}

/**
 * Notes and prompts are workspace-global, so they key by `projectId`. The
 * shared-container recipient scope is the exception: every share lives under
 * the one reserved viewer project id, so its items key by the container too.
 */
export function workspaceItemsKey(
  projectId: string,
  worktreeId?: string,
): string {
  return projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID &&
    worktreeId !== undefined
    ? `${projectId}/${worktreeId}`
    : projectId;
}

/** Request scope: the viewer's read adapter needs the container id. */
function itemsScope(
  projectId: string,
  worktreeId?: string,
): { projectId: string; worktreeId?: string } {
  return projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID &&
    worktreeId !== undefined
    ? { projectId, worktreeId }
    : { projectId };
}

interface WorkspaceItemsState {
  notes: Record<string, WorkspaceNoteItem[]>;
  prompts: Record<string, WorkspacePromptItem[]>;
  attachments: Record<string, WorkspaceAttachmentItem[]>;

  loadNotes: (projectId: string, worktreeId?: string) => Promise<void>;
  saveNote: (params: {
    projectId: string;
    noteId?: string;
    title: string;
    content: string;
    originWorktreeId?: string;
  }) => Promise<WorkspaceNoteItem | null>;
  deleteNote: (projectId: string, noteId: string) => Promise<void>;
  readNote: (
    projectId: string,
    noteId: string,
    worktreeId?: string,
  ) => Promise<{ meta: WorkspaceNoteItem; content: string } | null>;

  loadPrompts: (projectId: string, worktreeId?: string) => Promise<void>;
  savePrompt: (params: {
    projectId: string;
    promptId?: string;
    title: string;
    content: string;
    originWorktreeId?: string;
  }) => Promise<WorkspacePromptItem | null>;
  deletePrompt: (projectId: string, promptId: string) => Promise<void>;
  readPrompt: (
    projectId: string,
    promptId: string,
    worktreeId?: string,
  ) => Promise<{ meta: WorkspacePromptItem; content: string } | null>;

  loadAttachments: (
    projectId: string,
    worktreeId: string,
    isCurrent?: () => boolean,
  ) => Promise<void>;
  importAttachments: (
    params: {
      projectId: string;
      worktreeId: string;
      filePaths: string[];
      clipboardItems?: ClipboardAttachmentData[];
    },
    isCurrent?: () => boolean,
  ) => Promise<WorkspaceAttachmentItem[]>;
  deleteAttachment: (
    projectId: string,
    worktreeId: string,
    filename: string,
    isCurrent?: () => boolean,
  ) => Promise<void>;
}

export const useWorkspaceItemsStore = create<WorkspaceItemsState>(
  (set, get) => ({
    notes: {},
    prompts: {},
    attachments: {},

    loadNotes: async (projectId, worktreeId): Promise<void> => {
      try {
        // Notes live in a local workspace; a cloud project has none here.
        const items = isWebCoreScope(projectId)
          ? []
          : await window.api.workspaceItems.listNotes(
              itemsScope(projectId, worktreeId),
            );
        const key = workspaceItemsKey(projectId, worktreeId);
        set((state) => ({ notes: { ...state.notes, [key]: items } }));
      } catch {
        // Listing is best-effort; the card shows its empty state.
      }
    },

    saveNote: async (params): Promise<WorkspaceNoteItem | null> => {
      try {
        const saved = await window.api.workspaceItems.saveNote(params);
        await get().loadNotes(params.projectId);
        return saved;
      } catch {
        return null;
      }
    },

    deleteNote: async (projectId, noteId): Promise<void> => {
      try {
        await window.api.workspaceItems.deleteNote({ projectId, noteId });
      } finally {
        await get().loadNotes(projectId);
      }
    },

    readNote: async (
      projectId,
      noteId,
      worktreeId,
    ): Promise<{ meta: WorkspaceNoteItem; content: string } | null> => {
      try {
        return await window.api.workspaceItems.readNote({
          ...itemsScope(projectId, worktreeId),
          noteId,
        });
      } catch {
        return null;
      }
    },

    loadPrompts: async (projectId, worktreeId): Promise<void> => {
      try {
        // Prompts live in a local workspace; a cloud project has none here.
        const items = isWebCoreScope(projectId)
          ? []
          : await window.api.workspaceItems.listPrompts(
              itemsScope(projectId, worktreeId),
            );
        const key = workspaceItemsKey(projectId, worktreeId);
        set((state) => ({
          prompts: { ...state.prompts, [key]: items },
        }));
      } catch {
        // Listing is best-effort; the card shows its empty state.
      }
    },

    savePrompt: async (params): Promise<WorkspacePromptItem | null> => {
      try {
        const saved = await window.api.workspaceItems.savePrompt(params);
        await get().loadPrompts(params.projectId);
        return saved;
      } catch {
        return null;
      }
    },

    deletePrompt: async (projectId, promptId): Promise<void> => {
      try {
        await window.api.workspaceItems.deletePrompt({ projectId, promptId });
      } finally {
        await get().loadPrompts(projectId);
      }
    },

    readPrompt: async (
      projectId,
      promptId,
      worktreeId,
    ): Promise<{ meta: WorkspacePromptItem; content: string } | null> => {
      try {
        return await window.api.workspaceItems.readPrompt({
          ...itemsScope(projectId, worktreeId),
          promptId,
        });
      } catch {
        return null;
      }
    },

    loadAttachments: async (
      projectId,
      worktreeId,
      isCurrent,
    ): Promise<void> => {
      if (isCurrent?.() === false) return;
      try {
        const items = await window.api.workspaceItems.listAttachments({
          projectId,
          worktreeId,
        });
        if (isCurrent?.() === false) return;
        set((state) => ({
          attachments: {
            ...state.attachments,
            [attachmentsKey(projectId, worktreeId)]: items,
          },
        }));
      } catch {
        // Listing is best-effort; the card shows its empty state.
      }
    },

    importAttachments: async (
      params,
      isCurrent,
    ): Promise<WorkspaceAttachmentItem[]> => {
      if (isCurrent?.() === false) return [];
      const response =
        await window.api.workspaceItems.importAttachments(params);
      if (isCurrent?.() === false) return [];
      await get().loadAttachments(
        params.projectId,
        params.worktreeId,
        isCurrent,
      );
      if (isCurrent?.() === false) return [];
      return response.attachments;
    },

    deleteAttachment: async (
      projectId,
      worktreeId,
      filename,
      isCurrent,
    ): Promise<void> => {
      if (isCurrent?.() === false) return;
      try {
        await window.api.workspaceItems.deleteAttachment({
          projectId,
          worktreeId,
          filename,
        });
      } finally {
        await get().loadAttachments(projectId, worktreeId, isCurrent);
      }
    },
  }),
);
