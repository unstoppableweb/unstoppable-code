import {
  CLOUD_ATTACHMENT_MAX_BYTES,
  CLOUD_ATTACHMENT_MEDIA_TYPES,
  isCloudAttachmentFilename,
  isCloudAttachmentMediaType,
  mediaTypeForAttachmentFilename,
  type CloudAttachmentMediaType,
} from '@canopy/protocol/cloud-attachments';
import type { FilePreviewResponse } from '@canopy/desktop-shared/types';

/*
 * A cloud chat's attachments on desktop (CAN-6175 R6). A file uploads to its
 * chat when it is attached, and the composer keeps it as a pending attachment
 * whose path names the uploaded attachment, never a file on this computer:
 * nothing reads such a path from disk, and the send carries its id.
 */

const PATH_PREFIX = 'web-core-attachment:';

/** What the composer's file picker offers for a cloud chat. */
export const CLOUD_ATTACHMENT_ACCEPT = CLOUD_ATTACHMENT_MEDIA_TYPES.join(',');

/** The pending attachment path of an uploaded attachment; it ends in its filename. */
export function cloudAttachmentPath(
  attachmentId: string,
  filename: string,
): string {
  return `${PATH_PREFIX}${attachmentId}/${filename}`;
}

export function isCloudAttachmentPath(path: string): boolean {
  return path.startsWith(PATH_PREFIX);
}

/** The attachment id a pending attachment path names, or null for a local file. */
export function cloudAttachmentIdOfPath(path: string): string | null {
  if (!isCloudAttachmentPath(path)) return null;
  const rest = path.slice(PATH_PREFIX.length);
  const slash = rest.indexOf('/');
  const id = slash < 0 ? rest : rest.slice(0, slash);
  return id.length > 0 ? id : null;
}

/** A file's media type as the web core takes it, or null when it takes none. */
export function cloudAttachmentMediaType(file: {
  readonly name: string;
  readonly type: string;
}): CloudAttachmentMediaType | null {
  return isCloudAttachmentMediaType(file.type)
    ? file.type
    : mediaTypeForAttachmentFilename(file.name);
}

/**
 * Why the web core would refuse a file, as the web composer says it, or null
 * for a file it takes. Checked before any bytes are read.
 */
export function cloudAttachmentRefusal(file: {
  readonly name: string;
  readonly size: number;
  readonly type: string;
}): string | null {
  if (!isCloudAttachmentFilename(file.name))
    return 'Attachment filename is not supported';
  if (file.size === 0) return 'Attachment is empty';
  if (file.size > CLOUD_ATTACHMENT_MAX_BYTES) return 'Attachment is too large';
  if (cloudAttachmentMediaType(file) === null)
    return 'Attachment type is not supported';
  return null;
}

/** The web composer's words for a message past the attachment limit. */
export const CLOUD_ATTACHMENT_LIMIT_MESSAGE =
  'Attach up to eight files per message. Remove a file before adding more.';

const TEXT_PREVIEW_BYTES = 64 * 1024;
/** Uploaded files whose previews stay in memory; older ones show no preview. */
const MAX_PREVIEWS = 32;
const previews = new Map<string, FilePreviewResponse>();

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}

/** Keeps an uploaded file's preview, from the bytes already read to upload it. */
export function rememberCloudAttachmentPreview(
  path: string,
  file: {
    readonly filename: string;
    readonly mediaType: CloudAttachmentMediaType;
    readonly bytes: Uint8Array;
  },
): void {
  const { filename, mediaType, bytes } = file;
  const textual =
    mediaType.startsWith('text/') || mediaType === 'application/json';
  const shown = textual ? bytes.subarray(0, TEXT_PREVIEW_BYTES) : bytes;
  const preview: FilePreviewResponse = {
    kind: mediaType.startsWith('image/')
      ? 'image'
      : mediaType === 'text/markdown'
        ? 'markdown'
        : textual
          ? 'text'
          : 'unsupported',
    content: mediaType.startsWith('image/')
      ? `data:${mediaType};base64,${base64(bytes)}`
      : textual
        ? new TextDecoder().decode(shown)
        : '',
    filename,
    sizeBytes: bytes.byteLength,
    truncated: textual && shown.byteLength < bytes.byteLength,
    modifiedAtMs: 0,
  };
  previews.delete(path);
  previews.set(path, preview);
  for (const oldest of previews.keys()) {
    if (previews.size <= MAX_PREVIEWS) break;
    previews.delete(oldest);
  }
}

/**
 * The preview of a cloud attachment path, from memory: no cloud path is ever
 * read through main. Undefined for a local path, which main previews.
 */
export function cloudAttachmentPreview(
  path: string,
): FilePreviewResponse | undefined {
  if (!isCloudAttachmentPath(path)) return undefined;
  const filename = path.slice(path.lastIndexOf('/') + 1);
  return (
    previews.get(path) ?? {
      kind: 'unsupported',
      content: '',
      filename,
      sizeBytes: 0,
      truncated: false,
      modifiedAtMs: 0,
    }
  );
}
