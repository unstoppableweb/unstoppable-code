import type { CloudChatFileDownloadResult } from '@canopy/desktop-shared/types';
import type { CanopyCoreRelayApi } from '../../../shared/canopy-core-relay';
import type { WebCoreFileLocation } from '@/lib/chat-authority';
import {
  ambiguousDeliverableMessage,
  cloudDeliverableName,
  savedDeliverable,
} from '@/lib/files/saved-deliverables';
import { bareScope, qualifiedId } from '@/stores/chat/web-core/translate';

export { ambiguousDeliverableMessage, cloudDeliverableName };

/** A download, or more than one of the task's chats saved its name. */
export type CloudDeliverableDownloadResult =
  | CloudChatFileDownloadResult
  | { readonly ok: false; readonly reason: 'ambiguous' };

/*
 * Saving a cloud chat's deliverable from the desktop viewer (CAN-6587): main
 * asks where and reads the saved copy's bytes on its own web core connection.
 */

/**
 * Saves the deliverable at `location` through main's save dialog, read in the
 * scope of the chat that saved it. A file that isn't a deliverable, or that
 * the task's chats don't list exactly once, is not found.
 */
export async function downloadCloudDeliverable(
  relay: CanopyCoreRelayApi,
  scope: { readonly projectId: string; readonly worktreeId: string },
  location: WebCoreFileLocation,
): Promise<CloudDeliverableDownloadResult> {
  const name = cloudDeliverableName(location.relativePath);
  if (name === null) return { ok: false, reason: 'not_found' };
  const saved = await savedDeliverable(relay, location.chatId, name, scope);
  if (saved === 'ambiguous') return { ok: false, reason: 'ambiguous' };
  if (saved === null) return { ok: false, reason: 'not_found' };
  return window.api.cloudChats.downloadFile(
    { key: qualifiedId(saved.chatId), ...bareScope(scope) },
    { kind: 'deliverable', id: saved.id, filename: name },
  );
}
