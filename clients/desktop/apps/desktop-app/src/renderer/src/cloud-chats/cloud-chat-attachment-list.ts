import {
  CoreArtifactListResultSchema,
  WorkerArtifactDeleteResultSchema,
} from '@canopy/protocol/canopy-core';
import type { z } from 'zod';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import type { CanopyCoreRelayApi } from '../../../shared/canopy-core-relay';
import { requestWebCore } from '@/lib/files/web-core-file-source';

/*
 * A cloud chat's attachments for the activity rail (CAN-6175 R8d): listed
 * with `core.artifact.list` and deleted with `worker.artifact.delete` over the
 * web core relay, by the chat's web core id. Their bytes never cross the
 * relay; main saves them (`cloudChats.downloadFile`, CAN-6587).
 */

export interface CloudChatAttachmentRow {
  readonly attachmentId: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly mediaType: string;
}

export type CloudChatAttachmentList =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | {
      readonly kind: 'ready';
      readonly rows: readonly CloudChatAttachmentRow[];
    };

type CoreArtifactListResult = z.output<typeof CoreArtifactListResultSchema>;

/** One page holds a message's limit many times over; a chat rarely needs two. */
const PAGE_LIMIT = 100;
const MAX_PAGES = 10;

const lists = new Map<string, CloudChatAttachmentList>();
/** The newest read of each chat, so an older answer never replaces it. */
const reads = new Map<string, number>();
const listeners = new Set<() => void>();
let readCount = 0;

function publish(chatId: string, list: CloudChatAttachmentList): void {
  lists.set(chatId, list);
  for (const listener of listeners) listener();
}

/** A chat's attachments as last read, or undefined before the first read. */
export function cloudChatAttachmentList(
  chatId: string,
): CloudChatAttachmentList | undefined {
  return lists.get(chatId);
}

export function subscribeCloudChatAttachmentLists(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The attachment id of an `att:<chatId>:<attachmentId>` artifact of `chatId`. */
function attachmentIdOf(chatId: string, artifactId: string): string | null {
  const prefix = `att:${chatId}:`;
  if (!artifactId.startsWith(prefix)) return null;
  const id = artifactId.slice(prefix.length);
  return id === '' ? null : id;
}

/**
 * Reads a chat's attachments, newest first. The rows already shown stay
 * while it reads; a failed read shows the error until the next one.
 */
export async function refreshCloudChatAttachments(
  relay: CanopyCoreRelayApi,
  chatId: string,
): Promise<void> {
  readCount += 1;
  const read = readCount;
  reads.set(chatId, read);
  if (lists.get(chatId)?.kind !== 'ready') publish(chatId, { kind: 'loading' });
  try {
    const rows: CloudChatAttachmentRow[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const listed: CoreArtifactListResult = await requestWebCore(
        relay,
        'core.artifact.list',
        {
          owner: { kind: 'chat', id: chatId },
          kinds: ['attachment'],
          states: ['available'],
          cursor,
          limit: PAGE_LIMIT,
        },
        CoreArtifactListResultSchema,
      );
      for (const artifact of listed.artifacts) {
        const attachmentId = attachmentIdOf(chatId, artifact.artifactId);
        if (attachmentId === null) continue;
        rows.push({
          attachmentId,
          filename: artifact.name,
          sizeBytes: artifact.sizeBytes,
          mediaType: artifact.mediaType,
        });
      }
      cursor = listed.nextCursor;
      if (cursor === null) break;
    }
    if (reads.get(chatId) === read) publish(chatId, { kind: 'ready', rows });
  } catch (error) {
    // The section shows the error with Try again; record why it failed.
    reportClientAppError(error);
    if (reads.get(chatId) === read) publish(chatId, { kind: 'error' });
  }
}

/** Reads a chat's attachments unless they were read or are being read. */
export function ensureCloudChatAttachments(
  relay: CanopyCoreRelayApi,
  chatId: string,
): void {
  if (!lists.has(chatId)) void refreshCloudChatAttachments(relay, chatId);
}

/** Deletes one of a chat's attachments, then reads the list again. */
export async function deleteCloudChatAttachment(
  relay: CanopyCoreRelayApi,
  chatId: string,
  attachmentId: string,
): Promise<void> {
  await requestWebCore(
    relay,
    'worker.artifact.delete',
    { artifactId: `attachment:${attachmentId}`, scope: { chatId } },
    WorkerArtifactDeleteResultSchema,
  );
  await refreshCloudChatAttachments(relay, chatId);
}

/** A chat gained an attachment elsewhere (the composer): reread a shown list. */
export function cloudChatAttachmentAdded(
  relay: CanopyCoreRelayApi,
  chatId: string,
): void {
  if (lists.has(chatId)) void refreshCloudChatAttachments(relay, chatId);
}
