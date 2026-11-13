import { z } from 'zod';

import { CanopyWorkspaceScopeSchema } from '../common';
import {
  CanopyStreamCursorSchema,
  CanopyStreamEndSchema,
} from '../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
  CanopyJsonValueSchema,
  isBoundedCanopyJsonValue,
} from '../errors';

const BOUNDED_FILE_ROOT_ID_SCHEMA = z.string().min(1).max(512);
const CATALOG_REVISION_SCHEMA = z.string().min(1).max(128);

function stripLocalPathFields<Value extends Record<string, unknown>>(
  value: Value,
): Value {
  delete value.hostPath;
  delete value.absolutePath;
  return value;
}

export const WorkerFilesystemRootsListParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema,
  catalogRevision: CATALOG_REVISION_SCHEMA.optional(),
});

export type WorkerFilesystemRootsListParams = z.output<
  typeof WorkerFilesystemRootsListParamsSchema
>;

export const WorkerFilesystemRootSchema = z
  .object({
    fileRootId: BOUNDED_FILE_ROOT_ID_SCHEMA,
    name: z.string(),
    kind: z.enum(['git-repo', 'workspace-root', 'attachments', 'standalone']),
  })
  .catchall(CanopyJsonValueSchema)
  .refine(isBoundedCanopyJsonValue, 'Expected bounded JSON-safe data')
  .transform(stripLocalPathFields);

export const WorkerFilesystemRootsListResultSchema = z
  .object({
    roots: z.array(WorkerFilesystemRootSchema),
    catalogRevision: CATALOG_REVISION_SCHEMA.optional(),
  })
  .catchall(CanopyJsonValueSchema);

export type WorkerFilesystemRootsListResult = z.output<
  typeof WorkerFilesystemRootsListResultSchema
>;

export const WorkerFilesystemDirectoryListParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema,
  fileRootId: BOUNDED_FILE_ROOT_ID_SCHEMA,
  relativePath: z.string(),
  catalogRevision: CATALOG_REVISION_SCHEMA.optional(),
});

export type WorkerFilesystemDirectoryListParams = z.output<
  typeof WorkerFilesystemDirectoryListParamsSchema
>;

export const WorkerFilesystemDirectoryEntrySchema = z
  .object({
    name: z.string(),
    relativePath: z.string(),
    kind: z.enum(['file', 'directory']),
    isIgnored: z.boolean(),
    isIndexExcluded: z.boolean(),
    isSymlink: z.boolean(),
    hasChildren: z.boolean(),
  })
  .catchall(CanopyJsonValueSchema)
  .refine(isBoundedCanopyJsonValue, 'Expected bounded JSON-safe data')
  .transform(stripLocalPathFields);

export const WorkerFilesystemDirectoryListResultSchema = z
  .object({
    entries: z.array(WorkerFilesystemDirectoryEntrySchema),
    catalogRevision: CATALOG_REVISION_SCHEMA.optional(),
  })
  .catchall(CanopyJsonValueSchema);

export type WorkerFilesystemDirectoryListResult = z.output<
  typeof WorkerFilesystemDirectoryListResultSchema
>;

export const WorkerFilesystemRootsListErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        'worker.filesystem.roots.invalidState',
        'worker.filesystem.roots.revisionConflict',
        'worker.filesystem.roots.notFound',
      ])
      .optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });

export const WorkerFilesystemDirectoryListErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        'worker.filesystem.directory.invalidState',
        'worker.filesystem.directory.revisionConflict',
        'worker.filesystem.directory.notFound',
      ])
      .optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });

/** The preview cap for `worker.filesystem.file.read`, the desktop's 5 MiB. */
export const WORKER_FILESYSTEM_FILE_READ_MAX_BYTES = 5 * 1024 * 1024;

/**
 * The JSON-encoded result budget on a framed binding: the 8 MiB frame less
 * room for the envelope.
 */
export const WORKER_FILESYSTEM_FILE_READ_MAX_RESULT_BYTES = 7.5 * 1024 * 1024;

/** Base64 of the largest image the read returns. */
const FILE_READ_MAX_CONTENT_LENGTH =
  Math.ceil(WORKER_FILESYSTEM_FILE_READ_MAX_BYTES / 3) * 4;

export const WORKER_FILESYSTEM_FILE_CONTENT_KINDS = [
  'text',
  'markdown',
  'html',
  'image',
  'unsupported',
] as const;
export type WorkerFilesystemFileContentKind =
  (typeof WORKER_FILESYSTEM_FILE_CONTENT_KINDS)[number];

// Moved from the desktop `file:read-content` reader (CAN-4099) and shared
// with the web core (CAN-4159); the `worker.filesystem.file.read` spec lists
// the same tables.
const IMAGE_MEDIA_TYPES: ReadonlyMap<string, string> = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.bmp', 'image/bmp'],
]);

const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set(['.md', '.mdx']);

const HTML_EXTENSIONS: ReadonlySet<string> = new Set(['.html', '.htm']);

const KNOWN_BINARY_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.a',
  '.o',
  '.lib',
  '.obj',
  '.class',
  '.jar',
  '.war',
  '.pyc',
  '.pyo',
  '.wasm',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.iso',
  '.dmg',
  '.pkg',
  '.deb',
  '.rpm',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
  '.rtf',
  '.ico',
  '.icns',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.eot',
  '.mp3',
  '.mp4',
  '.m4a',
  '.m4v',
  '.mov',
  '.avi',
  '.mkv',
  '.webm',
  '.wav',
  '.flac',
  '.ogg',
  '.opus',
  '.aac',
  '.wma',
  '.psd',
  '.ai',
  '.sketch',
  '.fig',
  '.blend',
  '.fbx',
  '.stl',
  '.db',
  '.sqlite',
  '.sqlite3',
  '.mdb',
  '.bin',
  '.dat',
  '.pack',
  '.idx',
]);

/** `path.extname`, lowercased, without Node: a leading dot is no extension. */
function fileExtension(fileName: string): string {
  // Desktop passes host paths, so `\` separates too.
  const name = fileName.slice(
    Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\')) + 1,
  );
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/** Classifies a file by the lowercase extension of its resolved name. */
export function classifyFileContentKind(
  fileName: string,
): WorkerFilesystemFileContentKind {
  const extension = fileExtension(fileName);
  if (IMAGE_MEDIA_TYPES.has(extension)) return 'image';
  if (MARKDOWN_EXTENSIONS.has(extension)) return 'markdown';
  if (HTML_EXTENSIONS.has(extension)) return 'html';
  if (KNOWN_BINARY_FILE_EXTENSIONS.has(extension)) return 'unsupported';
  // Unknown extensions are text until a NUL byte proves them binary.
  return 'text';
}

/** The media type of an image the read returns, by its resolved name. */
export function fileImageMediaType(fileName: string): string | undefined {
  return IMAGE_MEDIA_TYPES.get(fileExtension(fileName));
}

export const WorkerFilesystemFileReadParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema,
  fileRootId: BOUNDED_FILE_ROOT_ID_SCHEMA,
  relativePath: z.string().max(4096),
  maxBytes: z.number().int().min(1).max(WORKER_FILESYSTEM_FILE_READ_MAX_BYTES),
  catalogRevision: CATALOG_REVISION_SCHEMA.optional(),
});

export type WorkerFilesystemFileReadParams = z.output<
  typeof WorkerFilesystemFileReadParamsSchema
>;

// Never refine this with `isBoundedCanopyJsonValue`: it bounds the whole
// serialized object at 32,768 characters, so every larger preview would fail.
export const WorkerFilesystemFileReadResultSchema = z
  .object({
    fileRootId: BOUNDED_FILE_ROOT_ID_SCHEMA,
    relativePath: z.string().max(4096),
    name: z.string().min(1).max(1024),
    contentKind: z.enum(WORKER_FILESYSTEM_FILE_CONTENT_KINDS),
    encoding: z.enum(['utf8', 'base64']),
    content: z.string().max(FILE_READ_MAX_CONTENT_LENGTH),
    mediaType: z.string().min(1).max(255).optional(),
    sizeBytes: z.number().int().min(0),
    returnedBytes: z.number().int().min(0),
    truncated: z.boolean(),
    modifiedAt: z.iso.datetime({ offset: true }),
    version: z.string().min(1).max(512),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    catalogRevision: CATALOG_REVISION_SCHEMA.optional(),
  })
  .catchall(CanopyJsonValueSchema)
  .refine(carriesNoLocalPath, 'Host paths never cross this boundary');

export type WorkerFilesystemFileReadResult = z.output<
  typeof WorkerFilesystemFileReadResultSchema
>;

export const WORKER_FILESYSTEM_FILE_READ_ERROR_CODES = [
  'worker.filesystem.file.invalidState',
  'worker.filesystem.file.revisionConflict',
  'worker.filesystem.file.notFound',
  'worker.filesystem.file.outsideRoots',
  'worker.filesystem.file.notRegularFile',
  'worker.filesystem.file.tooLarge',
] as const;

export const WorkerFilesystemFileReadErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z.enum(WORKER_FILESYSTEM_FILE_READ_ERROR_CODES).optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });

/**
 * The largest `worker.filesystem.search` page: the desktop explorer's
 * 25,000-entry index cap, so a one-root explorer index is one page.
 */
export const WORKER_FILESYSTEM_SEARCH_MAX_LIMIT = 25_000;

/** The page size when a search request omits `limit`. */
export const WORKER_FILESYSTEM_SEARCH_DEFAULT_LIMIT = 1_000;

/** A framed binding's JSON-encoded page budget, as for `file.read`. */
export const WORKER_FILESYSTEM_SEARCH_MAX_RESULT_BYTES = 7.5 * 1024 * 1024;

/**
 * A match's `path` and `name` bound, in UTF-16 units: Windows' 32,767-unit
 * extended path limit, the longest path any supported platform can walk, so
 * no indexed file fails validation. One match stays far below the page budget.
 */
export const WORKER_FILESYSTEM_SEARCH_MAX_PATH_LENGTH = 32_767;

export const WORKER_FILESYSTEM_SEARCH_MODES = [
  'name',
  'content',
  'symbol',
] as const;

/**
 * Which matcher walks the root: `mentions` applies the user's indexing
 * preferences; `file-explorer` hides only `.git` and walks dependency trees
 * last.
 */
export const WORKER_FILESYSTEM_SEARCH_PURPOSES = [
  'mentions',
  'file-explorer',
] as const;
export type WorkerFilesystemSearchPurpose =
  (typeof WORKER_FILESYSTEM_SEARCH_PURPOSES)[number];

const SEARCH_GLOBS_SCHEMA = z.array(z.string().max(1024)).max(128);

export const WorkerFilesystemSearchParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema,
  fileRootId: BOUNDED_FILE_ROOT_ID_SCHEMA,
  query: z.string().max(4096),
  mode: z.enum(WORKER_FILESYSTEM_SEARCH_MODES),
  purpose: z.enum(WORKER_FILESYSTEM_SEARCH_PURPOSES).optional(),
  include: SEARCH_GLOBS_SCHEMA.optional(),
  exclude: SEARCH_GLOBS_SCHEMA.optional(),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(WORKER_FILESYSTEM_SEARCH_MAX_LIMIT)
    .optional(),
  maxBytesPerMatch: z.number().int().min(0).max(65536).optional(),
  catalogRevision: CATALOG_REVISION_SCHEMA.optional(),
});

export type WorkerFilesystemSearchParams = z.output<
  typeof WorkerFilesystemSearchParamsSchema
>;

// One page can hold 25,000 matches: never add a catchall or a per-entry
// `isBoundedCanopyJsonValue` refinement here. Unknown match fields strip.
export const WorkerFilesystemSearchMatchSchema = z.object({
  fileRootId: BOUNDED_FILE_ROOT_ID_SCHEMA,
  path: z.string().min(1).max(WORKER_FILESYSTEM_SEARCH_MAX_PATH_LENGTH),
  kind: z.enum(['file', 'directory', 'symbol']),
  name: z.string().min(1).max(WORKER_FILESYSTEM_SEARCH_MAX_PATH_LENGTH),
  isIgnored: z.boolean(),
  line: z.number().int().min(1).optional(),
  column: z.number().int().min(1).optional(),
  preview: z.string().max(65536).optional(),
  score: z.number().optional(),
});

export type WorkerFilesystemSearchMatch = z.output<
  typeof WorkerFilesystemSearchMatchSchema
>;

export const WorkerFilesystemSearchResultSchema = z.object({
  matches: z.array(WorkerFilesystemSearchMatchSchema),
  nextCursor: z.string().min(1).max(2048).nullable(),
  truncated: z.boolean(),
  catalogRevision: CATALOG_REVISION_SCHEMA.optional(),
});

export type WorkerFilesystemSearchResult = z.output<
  typeof WorkerFilesystemSearchResultSchema
>;

export const WORKER_FILESYSTEM_SEARCH_ERROR_CODES = [
  'worker.filesystem.search.invalidState',
  'worker.filesystem.search.revisionConflict',
  'worker.filesystem.search.notFound',
  'worker.filesystem.search.modeUnavailable',
  'worker.filesystem.search.cursorExpired',
  'worker.filesystem.search.cursorMismatch',
] as const;

export const WorkerFilesystemSearchErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z.enum(WORKER_FILESYSTEM_SEARCH_ERROR_CODES).optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });

/** `markdown`: relative to a base file; `transcript`: one file across roots. */
export const WORKER_FILESYSTEM_LINK_RESOLVE_MODES = [
  'markdown',
  'transcript',
] as const;
export type WorkerFilesystemLinkResolveMode =
  (typeof WORKER_FILESYSTEM_LINK_RESOLVE_MODES)[number];

/**
 * A root-relative path bound, in UTF-16 units: Windows' 32,767-unit extended
 * path limit, the longest path any supported platform can open.
 */
export const WORKER_FILESYSTEM_LINK_MAX_PATH_LENGTH = 32_767;

/**
 * Ten characters per path unit: a `file:` URL of the longest path with every
 * unit percent-encoded (up to nine characters) still fits, with its scheme.
 */
export const WORKER_FILESYSTEM_LINK_HREF_MAX_LENGTH =
  10 * WORKER_FILESYSTEM_LINK_MAX_PATH_LENGTH;

export const WorkerFilesystemLinkBaseSchema = z.strictObject({
  fileRootId: BOUNDED_FILE_ROOT_ID_SCHEMA,
  relativePath: z.string().max(WORKER_FILESYSTEM_LINK_MAX_PATH_LENGTH),
});

export type WorkerFilesystemLinkBase = z.output<
  typeof WorkerFilesystemLinkBaseSchema
>;

export const WorkerFilesystemLinkResolveParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema,
  mode: z.enum(WORKER_FILESYSTEM_LINK_RESOLVE_MODES),
  href: z.string().max(WORKER_FILESYSTEM_LINK_HREF_MAX_LENGTH),
  base: WorkerFilesystemLinkBaseSchema.optional(),
  catalogRevision: CATALOG_REVISION_SCHEMA.optional(),
});

export type WorkerFilesystemLinkResolveParams = z.output<
  typeof WorkerFilesystemLinkResolveParamsSchema
>;

// Never refine this with `isBoundedCanopyJsonValue`: its 32,768-character
// bound would refuse a target at the path limit. The catchall bounds extras.
export const WorkerFilesystemLinkResolveResultSchema = z
  .object({
    fileRootId: BOUNDED_FILE_ROOT_ID_SCHEMA,
    relativePath: z.string().max(WORKER_FILESYSTEM_LINK_MAX_PATH_LENGTH),
    name: z.string().max(1024),
    kind: z.enum(['file', 'directory']),
    catalogRevision: CATALOG_REVISION_SCHEMA.optional(),
  })
  .catchall(CanopyJsonValueSchema)
  .refine(carriesNoLocalPath, 'Host paths never cross this boundary');

export type WorkerFilesystemLinkResolveResult = z.output<
  typeof WorkerFilesystemLinkResolveResultSchema
>;

export const WORKER_FILESYSTEM_LINK_RESOLVE_ERROR_CODES = [
  'worker.filesystem.link.invalidState',
  'worker.filesystem.link.revisionConflict',
  'worker.filesystem.link.notFound',
  'worker.filesystem.link.ambiguous',
  'worker.filesystem.link.outsideRoots',
  'worker.filesystem.link.symlinkEscape',
  'worker.filesystem.link.unsupported',
] as const;

export const WorkerFilesystemLinkResolveErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z.enum(WORKER_FILESYSTEM_LINK_RESOLVE_ERROR_CODES).optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });

export const WORKER_FILESYSTEM_GRANTS = {
  read: 'worker.filesystem.read',
  write: 'worker.filesystem.write',
} as const;

export const WORKER_FILESYSTEM_WATCH_SUBJECTS = ['tree', 'gitHead'] as const;
export type WorkerFilesystemWatchSubject =
  (typeof WORKER_FILESYSTEM_WATCH_SUBJECTS)[number];

export const WorkerFilesystemWatchParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema,
  fileRootId: BOUNDED_FILE_ROOT_ID_SCHEMA,
  relativePaths: z.array(z.string()).optional(),
  subject: z.enum(WORKER_FILESYSTEM_WATCH_SUBJECTS).optional(),
  cursor: CanopyStreamCursorSchema.nullable().optional(),
});

export type WorkerFilesystemWatchParams = z.output<
  typeof WorkerFilesystemWatchParamsSchema
>;

export const WorkerFilesystemWatchOpenResultSchema = z
  .object({
    subscriptionId: z.string().min(1).max(512),
    acceptedCursor: CanopyStreamCursorSchema.nullable(),
  })
  .catchall(CanopyJsonValueSchema);

function carriesNoLocalPath(value: Record<string, unknown>): boolean {
  return !('hostPath' in value) && !('absolutePath' in value);
}

export const WorkerFilesystemWatchItemSchema = z
  .object({
    changeId: z.string().min(1).max(512),
    kind: z.enum(['created', 'modified', 'deleted', 'renamed', 'overflow']),
    relativePath: z.string(),
    previousRelativePath: z.string().nullable(),
    version: z.string().nullable(),
    occurredAt: z.iso.datetime({ offset: true }),
    /** Native notifications folded into this item; additive in version 1. */
    eventCount: z.number().int().min(1).optional(),
  })
  .catchall(CanopyJsonValueSchema)
  .refine(isBoundedCanopyJsonValue, 'Expected bounded JSON-safe data')
  .refine(carriesNoLocalPath, 'Host paths never cross this boundary');

export type WorkerFilesystemWatchItem = z.output<
  typeof WorkerFilesystemWatchItemSchema
>;

export const WorkerFilesystemWatchErrorSchema = CanopyErrorPayloadSchema.extend(
  {
    code: z
      .enum([
        'worker.filesystem.watch.invalidState',
        'worker.filesystem.watch.notFound',
        'worker.filesystem.watch.snapshotRequired',
      ])
      .optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  },
);

export const WorkerFilesystemWatchEndSchema = CanopyStreamEndSchema.extend({
  error: WorkerFilesystemWatchErrorSchema.nullable(),
});
