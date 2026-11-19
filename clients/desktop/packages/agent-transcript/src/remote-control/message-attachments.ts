import { mediaTypeForAttachmentFilename } from '@canopy/protocol/cloud-attachments';
import type { RemoteControlChatMessageAttachment } from '@canopy/protocol/remote-control/shell';

const FALLBACK_MEDIA_TYPE = 'application/octet-stream';

/** 32-bit FNV-1a over UTF-16 code units, rendered as 8 hex chars. */
function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function basenameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const separator = Math.max(
    trimmed.lastIndexOf('/'),
    trimmed.lastIndexOf('\\'),
  );
  return separator === -1 ? trimmed : trimmed.slice(separator + 1);
}

/**
 * Stable, display-only identity for a desktop-local attachment path. Clients
 * use it only as a list key; it never resolves to bytes.
 */
export function remoteControlChatAttachmentIdForPath(path: string): string {
  return `path-${fnv1a32(path)}`;
}

/**
 * Project desktop `attachmentPaths` into the neutral display refs carried on
 * `RemoteControlChatMessage.attachments`. No byte size is available from a path
 * alone, so `size` is omitted (see `RemoteControlChatMessageAttachment`).
 */
export function remoteControlChatMessageAttachmentsFromPaths(
  paths: readonly string[],
): RemoteControlChatMessageAttachment[] {
  return remoteControlChatAttachmentPaths(paths).map((path) => {
    const filename = basenameOf(path) || 'attachment';
    return {
      attachmentId: remoteControlChatAttachmentIdForPath(path),
      filename,
      mediaType:
        mediaTypeForAttachmentFilename(filename) ?? FALLBACK_MEDIA_TYPE,
    };
  });
}

export function remoteControlChatAttachmentPaths(
  paths: readonly string[],
): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const path of paths) {
    if (
      typeof path !== 'string' ||
      path.trim().length === 0 ||
      seen.has(path)
    ) {
      continue;
    }
    seen.add(path);
    normalized.push(path);
  }
  return normalized;
}
