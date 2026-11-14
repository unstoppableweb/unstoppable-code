// ---------------------------------------------------------------------------
// Chat attachment helpers (renderer)
// ---------------------------------------------------------------------------
//
// Reusable logic for importing files/clipboard items as worktree attachments
// and staging them as pending attachments on a chat tab. Extracted verbatim
// from `ChatInput.tsx` so other surfaces (e.g. the in-app browser's
// "Pick & Polish" flow) can stage attachments without duplicating the import
// + index-refresh dance.

import { useSyncExternalStore } from 'react';
import {
  type AttachmentMeta,
  type ClipboardAttachmentData,
} from '@canopy/desktop-shared/types';
import { CLOUD_ATTACHMENTS_MAX_PER_MESSAGE } from '@canopy/protocol/cloud-attachments';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  CLOUD_ATTACHMENT_ACCEPT,
  CLOUD_ATTACHMENT_LIMIT_MESSAGE,
  cloudAttachmentMediaType,
  cloudAttachmentRefusal,
  rememberCloudAttachmentSource,
} from '@/cloud-chats/cloud-chat-attachments';
import { isCoworkChatTarget } from '@/lib/cowork';
import { useChatStore } from '@/stores/chatStore';
import { uploadWebCoreChatAttachment } from '@/stores/chat/web-core';
import { useFileListStore } from '@/stores/fileListStore';
import { useWorkspaceItemsStore } from '@/stores/workspaceItemsStore';

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'application/pdf': '.pdf',
};

export const ATTACHMENT_IMPORT_ERROR_MESSAGE =
  "Couldn't attach that file. It may have moved or become unavailable — try selecting it again.";

function mimeExtension(mimeType: string): string {
  return MIME_EXTENSIONS[mimeType] ?? '.png';
}

export interface AttachmentImportTarget {
  projectId: string;
  worktreeId: string;
}

export interface ActiveChatAttachmentTarget extends AttachmentImportTarget {
  chatId: string;
}

/**
 * Resolve the currently-active *editable* chat tab as an attachment target, or
 * `null` when there is no selected worktree or the active tab cannot accept
 * attachments (a file tab or a read-only tab). Used by surfaces that stage
 * attachments outside the composer (the in-app browser's Pick & Polish,
 * screenshot, and recording flows).
 */
export function resolveActiveEditableChatTarget(): ActiveChatAttachmentTarget | null {
  const chat = useChatStore.getState();
  const selected = chat.selectedWorktree;
  if (!selected) {
    return null;
  }
  const key = `${selected.projectId}/${selected.worktreeId}`;
  const worktreeChat = chat.worktreeChats[key];
  const activeTab = worktreeChat?.tabs.find(
    (tab) => tab.id === worktreeChat.activeTabId,
  );
  if (!activeTab || activeTab.kind === 'file' || activeTab.readOnly) {
    return null;
  }
  return {
    projectId: selected.projectId,
    worktreeId: selected.worktreeId,
    chatId: activeTab.id,
  };
}

function mapStandaloneAttachment(result: {
  filename: string;
  absolutePath: string;
  sizeBytes?: number;
}): AttachmentMeta {
  return {
    filename: result.filename,
    absolutePath: result.absolutePath,
    sizeBytes: result.sizeBytes,
  };
}

export async function fileToClipboardAttachment(
  file: File,
  fallbackBasename: string,
): Promise<ClipboardAttachmentData> {
  const buffer = await file.arrayBuffer();
  const mimeType = file.type || 'application/octet-stream';
  const ext = mimeExtension(mimeType);
  const filename = file.name || `${fallbackBasename}${ext}`;
  return { filename, data: new Uint8Array(buffer) };
}

export async function createClipboardAttachments(
  files: File[],
  fallbackBasename: string,
): Promise<ClipboardAttachmentData[]> {
  if (files.length === 0) {
    return [];
  }

  return Promise.all(
    files.map((file) => fileToClipboardAttachment(file, fallbackBasename)),
  );
}

export async function importChatAttachments(
  target: AttachmentImportTarget,
  filePaths: string[],
  clipboardItems?: ClipboardAttachmentData[],
  isCurrent?: () => boolean,
): Promise<AttachmentMeta[]> {
  if (isCurrent?.() === false) return [];
  // Cowork chats key as (workspaceId, 'home'); route their attachments through
  // the workspace-items attachment IPC, which stores them under the
  // workspace's managed `.{brand}/attachments` dir. `target.projectId` is the
  // cowork workspace id (the backend resolves legacy ids via
  // resolveCoworkWorkspaceId).
  if (isCoworkChatTarget(target.projectId)) {
    const result = await window.api.workspaceItems.importAttachments({
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      filePaths,
      clipboardItems,
    });
    if (isCurrent?.() === false) return [];
    await useWorkspaceItemsStore
      .getState()
      .loadAttachments(target.projectId, target.worktreeId, isCurrent);
    if (isCurrent?.() === false) return [];
    return result.attachments.map(mapStandaloneAttachment);
  }

  const result = await window.api.importWorktreeAttachments({
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    filePaths,
    clipboardItems,
  });
  if (isCurrent?.() === false) return [];
  // The Attachments activity card is backed by its own workspace-items
  // snapshot, separate from the file index refreshed when the attachment is
  // staged on the composer. Keep that snapshot current for paste, browse,
  // drag/drop, and other chat attachment import flows.
  await useWorkspaceItemsStore
    .getState()
    .loadAttachments(target.projectId, target.worktreeId, isCurrent);
  if (isCurrent?.() === false) return [];
  return result.attachments;
}

/** Why an upload to a cloud chat failed, in the composer's words. */
export const CLOUD_UPLOAD_FAILURE: Readonly<Record<string, string>> = {
  too_large: 'Attachment is too large',
  offline: "Couldn't upload it. Check your connection and try again",
  unauthenticated: 'Sign in again to attach files to cloud chats',
  disabled: "Attachments aren't available in this cloud chat",
  rejected: "Couldn't upload it",
};

/** A picked file that moved or could no longer be read before it uploaded. */
const UNREADABLE_FILE = "Couldn't read it. It may have moved";

/** Files the person picks for a cloud chat, from the renderer's own picker. */
function pickCloudAttachmentFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = CLOUD_ATTACHMENT_ACCEPT;
    input.addEventListener(
      'change',
      () => resolve(Array.from(input.files ?? [])),
      { once: true },
    );
    input.addEventListener('cancel', () => resolve([]), { once: true });
    input.click();
  });
}

/** Whether a file is one on this computer's disk, rather than pasted. */
function isDiskFile(file: File): boolean {
  try {
    return window.api.getPathForFile(file) !== '';
  } catch (error) {
    reportClientAppError(error);
    return false;
  }
}

/**
 * Uploads in flight per cloud chat: they count toward the message's limit
 * before they join its pending attachments, and keep the chat's Send off,
 * whoever started them: the composer, or a new chat taking a deleted one's
 * files again (CAN-6614).
 */
const uploadingByChat = new Map<string, number>();
const uploadListeners = new Set<() => void>();
let uploadsVersion = 0;

function setUploading(chatKey: string, count: number): void {
  if (count > 0) uploadingByChat.set(chatKey, count);
  else uploadingByChat.delete(chatKey);
  uploadsVersion += 1;
  for (const listener of [...uploadListeners]) listener();
}

/** Whether a cloud chat has uploads in flight, from any caller. */
export function useCloudChatUploading(
  target: { projectId: string; worktreeId: string; chatId: string } | null,
): boolean {
  useSyncExternalStore(
    (listener) => {
      uploadListeners.add(listener);
      return (): void => {
        uploadListeners.delete(listener);
      };
    },
    () => uploadsVersion,
  );
  return (
    target !== null &&
    (uploadingByChat.get(
      `${target.projectId}/${target.worktreeId}/${target.chatId}`,
    ) ?? 0) > 0
  );
}

/** What attaching files to a cloud chat attached, and why the rest were not. */
export interface WebCoreChatFilesResult {
  readonly attachments: AttachmentMeta[];
  /** One line per file left out, for the composer to show beside it. */
  readonly problems: string[];
}

/**
 * Attaches files to a cloud chat (CAN-6175 R6): each one the web core would
 * take uploads to that chat as it is attached, and comes back as a pending
 * attachment naming the upload. A file it would refuse, or one past the
 * message's limit, is left out with the web's words, before its bytes are
 * read. No files opens the picker. Nothing goes through main but the upload.
 */
export async function importWebCoreChatFiles(
  target: ActiveChatAttachmentTarget,
  files: readonly File[] | null,
  isCurrent?: () => boolean,
): Promise<WebCoreChatFilesResult> {
  const chosen = files ?? (await pickCloudAttachmentFiles());
  if (chosen.length === 0 || isCurrent?.() === false)
    return { attachments: [], problems: [] };
  const problems: string[] = [];
  const accepted = chosen.flatMap((file) => {
    const refusal = cloudAttachmentRefusal(file);
    const mediaType = cloudAttachmentMediaType(file);
    if (refusal === null && mediaType !== null) return [{ file, mediaType }];
    problems.push(
      `${file.name}: ${refusal ?? 'Attachment type is not supported'}`,
    );
    return [];
  });
  const key = `${target.projectId}/${target.worktreeId}`;
  const chatKey = `${key}/${target.chatId}`;
  const pending =
    useChatStore
      .getState()
      .worktreeChats[key]?.tabs.find((tab) => tab.id === target.chatId)
      ?.pendingAttachments?.length ?? 0;
  const room = Math.max(
    0,
    CLOUD_ATTACHMENTS_MAX_PER_MESSAGE -
      pending -
      (uploadingByChat.get(chatKey) ?? 0),
  );
  if (accepted.length > room) problems.push(CLOUD_ATTACHMENT_LIMIT_MESSAGE);
  const taken = accepted.slice(0, room);
  if (taken.length === 0) return { attachments: [], problems };
  setUploading(chatKey, (uploadingByChat.get(chatKey) ?? 0) + taken.length);
  // Each file settles on its own: one that can't be read or sent leaves the
  // rest attached.
  const uploads = taken.map(async ({ file, mediaType }) => {
    try {
      const result = await uploadWebCoreChatAttachment(target, {
        name: file.name,
        mediaType,
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
      if (result.ok) {
        // Kept so a new chat can take it again if this one is deleted
        // elsewhere (CAN-6614).
        if (isDiskFile(file))
          rememberCloudAttachmentSource(result.attachment.absolutePath, file);
        return result.attachment;
      }
      problems.push(
        `${file.name}: ${result.message ?? CLOUD_UPLOAD_FAILURE[result.reason] ?? CLOUD_UPLOAD_FAILURE.rejected}`,
      );
      return null;
    } catch (error) {
      reportClientAppError(error);
      problems.push(`${file.name}: ${UNREADABLE_FILE}`);
      return null;
    }
  });
  let settled: (AttachmentMeta | null)[];
  try {
    settled = await Promise.all(uploads);
  } finally {
    // Released together, as the composer then adds the batch to the chat's
    // pending attachments before any other attach can run.
    setUploading(chatKey, (uploadingByChat.get(chatKey) ?? 0) - taken.length);
  }
  const attachments = settled.filter(
    (attachment): attachment is AttachmentMeta => attachment !== null,
  );
  return isCurrent?.() === false
    ? { attachments: [], problems: [] }
    : { attachments, problems };
}

export function addPendingAttachmentsAndRefreshIndex(
  target: AttachmentImportTarget,
  attachments: AttachmentMeta[],
  addOverride?: (attachments: AttachmentMeta[]) => void,
  pendingTarget?: { projectId: string; worktreeId: string; chatId: string },
): void {
  if (attachments.length === 0) {
    return;
  }

  if (addOverride) {
    addOverride(attachments);
  } else {
    useChatStore.getState().addPendingAttachments(attachments, pendingTarget);
  }
  const fileStore = useFileListStore.getState();
  fileStore.invalidate(target.projectId, target.worktreeId);
  void fileStore.fetchFileIndex(target.projectId, target.worktreeId);
}
