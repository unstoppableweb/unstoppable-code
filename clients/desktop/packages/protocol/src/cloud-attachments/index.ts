export const CLOUD_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
// Paired with agentic-core CONTEXT_ATTACHMENTS_MAX_PER_MESSAGE.
export const CLOUD_ATTACHMENTS_MAX_PER_MESSAGE = 8;
// APFS, HFS+, NTFS, and common Linux filesystems cap a single filename
// component at 255 encoded bytes/code units. UTF-8 bytes are the strictest
// portable boundary for names crossing between supported hosts.
export const CLOUD_ATTACHMENT_FILENAME_MAX_BYTES = 255;

/** OOXML Word document (REG-2902), paired with Core's opaque media group. */
export const DOCX_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
/** OOXML Excel workbook (REG-2902), paired with Core's opaque media group. */
export const XLSX_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const CLOUD_ATTACHMENT_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  DOCX_MEDIA_TYPE,
  XLSX_MEDIA_TYPE,
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'application/json',
] as const;

export type CloudAttachmentMediaType =
  (typeof CLOUD_ATTACHMENT_MEDIA_TYPES)[number];

const mediaTypes = new Set<string>(CLOUD_ATTACHMENT_MEDIA_TYPES);

/** Characters that are invalid in portable attachment filenames. */
function buildControlCharacterPattern(): RegExp {
  const codes = Array.from({ length: 32 }, (_, code) => code);
  codes.push(127);
  const chars = codes.map((code) => String.fromCharCode(code)).join('');
  return new RegExp('[' + chars + ']');
}
const CONTROL_CHARACTER_PATTERN = buildControlCharacterPattern();
const WINDOWS_RESERVED_CHARACTER_PATTERN = /[<>:"|?*]/;
const TRAILING_DOT_OR_SPACE_PATTERN = /[. ]$/;
const WINDOWS_RESERVED_NAME_PATTERN =
  /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

/** Matches the desktop attachment materializer's portable stem transform. */
export function normalizeCloudAttachmentFilenameStem(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export function cloudAttachmentFilenameByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
  }
  return bytes;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let result = '';
  for (const character of value) {
    const characterBytes = cloudAttachmentFilenameByteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

/** Truncate without splitting a Unicode code point, preserving an extension. */
export function truncateCloudAttachmentFilename(value: string): string {
  if (
    cloudAttachmentFilenameByteLength(value) <=
    CLOUD_ATTACHMENT_FILENAME_MAX_BYTES
  ) {
    return value;
  }
  const dot = value.lastIndexOf('.');
  const extension = dot > 0 ? value.slice(dot) : '';
  const extensionBytes = cloudAttachmentFilenameByteLength(extension);
  if (
    extension.length === 0 ||
    extensionBytes >= CLOUD_ATTACHMENT_FILENAME_MAX_BYTES
  ) {
    return truncateUtf8(value, CLOUD_ATTACHMENT_FILENAME_MAX_BYTES);
  }
  return (
    truncateUtf8(
      value.slice(0, dot),
      CLOUD_ATTACHMENT_FILENAME_MAX_BYTES - extensionBytes,
    ) + extension
  );
}

export function isCloudAttachmentMediaType(
  value: unknown,
): value is CloudAttachmentMediaType {
  return typeof value === 'string' && mediaTypes.has(value);
}

export function isCloudImageAttachmentMediaType(value: unknown): boolean {
  return isCloudAttachmentMediaType(value) && value.startsWith('image/');
}

/**
 * Whether a filename can be materialized unchanged on every supported host.
 *
 * In addition to path separators and control characters, this rejects names
 * that Windows aliases, strips, or interprets as device paths.
 */
export function isCloudAttachmentFilename(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const dot = value.lastIndexOf('.');
  const stem = dot > 0 ? value.slice(0, dot) : value;
  const normalizedStem = normalizeCloudAttachmentFilenameStem(stem);
  return (
    value.trim().length > 0 &&
    cloudAttachmentFilenameByteLength(value) <=
      CLOUD_ATTACHMENT_FILENAME_MAX_BYTES &&
    !value.includes('/') &&
    !value.includes('\\') &&
    value !== '.' &&
    value !== '..' &&
    !CONTROL_CHARACTER_PATTERN.test(value) &&
    !WINDOWS_RESERVED_CHARACTER_PATTERN.test(value) &&
    !TRAILING_DOT_OR_SPACE_PATTERN.test(value) &&
    !WINDOWS_RESERVED_NAME_PATTERN.test(value) &&
    !WINDOWS_RESERVED_NAME_PATTERN.test(normalizedStem)
  );
}

const MEDIA_TYPE_BY_EXTENSION: Readonly<
  Record<string, CloudAttachmentMediaType>
> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  docx: DOCX_MEDIA_TYPE,
  xlsx: XLSX_MEDIA_TYPE,
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  json: 'application/json',
};

/**
 * Allowlisted media type for a filename's extension, or null when the
 * extension is unknown. Case-insensitive. Used by hosts that only know a
 * path (desktop transcript projection) and by pickers that must pre-check a
 * file before uploading it.
 */
export function mediaTypeForAttachmentFilename(
  filename: string,
): CloudAttachmentMediaType | null {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return null;
  const extension = filename.slice(dot + 1).toLowerCase();
  return MEDIA_TYPE_BY_EXTENSION[extension] ?? null;
}

export function remoteControlAttachmentMediaTypeForFilename(
  filename: string,
): string {
  return mediaTypeForAttachmentFilename(filename) ?? 'application/octet-stream';
}

export function isRemoteControlAttachmentMediaType(
  value: unknown,
): value is string {
  return (
    isCloudAttachmentMediaType(value) || value === 'application/octet-stream'
  );
}
