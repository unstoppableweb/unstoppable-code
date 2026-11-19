import type { FileViewMode } from '@canopy/app-state';
import type { RemoteControlFilePreview } from '@canopy/protocol/remote-control/shell';
import {
  DOCX_MEDIA_TYPE,
  XLSX_MEDIA_TYPE,
} from '@canopy/protocol/cloud-attachments';
import { VIDEO_PREVIEW_EXTENSIONS } from '@canopy/protocol/document-preview';

/**
 * How the shared {@link import('./FileViewer').FileViewer} should render a
 * file's text content. `image`/binary are out of scope for the neutral
 * text-only {@link RemoteControlFilePreview} (its `content` is always a string), so a
 * non-previewable file falls through to `code`. `pdf`/`docx`/`xlsx`/`pptx`/`video`
 * are rich-document kinds served by the host-injected byte resolver; hosts opt
 * in per kind through `supportedDocumentKinds`.
 */
export type FileRenderKind =
  | 'markdown'
  | 'html'
  | 'image'
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'video'
  | 'code';

/** Kinds routed through `resolveDocumentBytes` + `renderRichDocument`. */
export type RichDocumentRenderKind = Extract<
  FileRenderKind,
  'pdf' | 'docx' | 'xlsx' | 'pptx' | 'video'
>;

const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set([
  'md',
  'markdown',
  'mdx',
]);
const HTML_EXTENSIONS: ReadonlySet<string> = new Set(['html', 'htm']);
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
]);
const PDF_EXTENSIONS: ReadonlySet<string> = new Set(['pdf']);
// Macro-enabled variants (.docm/.xlsm/.pptm) carry different media types and
// stay download-only; REG-2903 owns legacy binary formats.
const DOCX_EXTENSIONS: ReadonlySet<string> = new Set(['docx']);
const XLSX_EXTENSIONS: ReadonlySet<string> = new Set(['xlsx']);
const PPTX_EXTENSIONS: ReadonlySet<string> = new Set(['pptx']);

const RICH_DOCUMENT_KINDS: ReadonlySet<FileRenderKind> =
  new Set<FileRenderKind>(['pdf', 'docx', 'xlsx', 'pptx', 'video']);

const MEDIA_TYPE_RENDER_KINDS: ReadonlyMap<string, RichDocumentRenderKind> =
  new Map([
    ['application/pdf', 'pdf'],
    [DOCX_MEDIA_TYPE, 'docx'],
    [XLSX_MEDIA_TYPE, 'xlsx'],
    [
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'pptx',
    ],
    ['video/mp4', 'video'],
    ['video/webm', 'video'],
  ]);

const PLAIN_TEXT_EXTENSIONS: ReadonlySet<string> = new Set(['txt', 'text']);

/** Whether a file is prose (Markdown or plain text) rather than code. */
export function isProseFilePath(path: string): boolean {
  const extension = fileExtension(path);
  return (
    MARKDOWN_EXTENSIONS.has(extension) || PLAIN_TEXT_EXTENSIONS.has(extension)
  );
}

/** Lower-cased extension (without the dot), or `''` for an extensionless path. */
export function fileExtension(path: string): string {
  const queryIndex = path.search(/[?#]/);
  const clean = queryIndex === -1 ? path : path.slice(0, queryIndex);
  const base = clean.slice(clean.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

export function isRichDocumentRenderKind(
  kind: FileRenderKind,
): kind is RichDocumentRenderKind {
  return RICH_DOCUMENT_KINDS.has(kind);
}

/**
 * Render kind for an attachment whose MIME type is authoritative (hosts pass
 * it as `requestRenderKind`); `undefined` for anything without a rich renderer.
 * The generic `application/octet-stream` names no format, so a `filename`
 * extension decides instead (agents often save videos with that type).
 */
export function fileRenderKindForMediaType(
  mediaType: string | undefined,
  filename?: string,
): RichDocumentRenderKind | undefined {
  if (mediaType === undefined) return undefined;
  const normalized = mediaType.split(';')[0].trim().toLowerCase();
  if (normalized === 'application/octet-stream' && filename !== undefined) {
    const kind = resolveFileRenderKind({ path: filename });
    return isRichDocumentRenderKind(kind) ? kind : undefined;
  }
  return MEDIA_TYPE_RENDER_KINDS.get(mediaType);
}

/**
 * Pick the render kind from the preview's path extension, falling back to the
 * server's `language` hint. Extension wins because a host may not populate
 * `language` for every file.
 */
export function resolveFileRenderKind(
  preview: Pick<RemoteControlFilePreview, 'path' | 'language'>,
): FileRenderKind {
  const extension = fileExtension(preview.path);
  if (MARKDOWN_EXTENSIONS.has(extension) || preview.language === 'markdown') {
    return 'markdown';
  }
  if (HTML_EXTENSIONS.has(extension) || preview.language === 'html') {
    return 'html';
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    return 'image';
  }
  if (PDF_EXTENSIONS.has(extension)) {
    return 'pdf';
  }
  if (DOCX_EXTENSIONS.has(extension)) {
    return 'docx';
  }
  if (XLSX_EXTENSIONS.has(extension)) {
    return 'xlsx';
  }
  if (PPTX_EXTENSIONS.has(extension)) {
    return 'pptx';
  }
  if (VIDEO_PREVIEW_EXTENSIONS.has(extension)) {
    return 'video';
  }
  return 'code';
}

function lastPathSegment(path: string): string {
  return path.slice(
    Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1,
  );
}

/**
 * Whether a path names a Jupyter notebook. Notebooks keep the `code` render
 * kind (their raw view is JSON text) and add a rendered view over the same
 * text session, the way CSV adds its table.
 */
export function isNotebookPath(path: string): boolean {
  return fileExtension(lastPathSegment(path)) === 'ipynb';
}

/**
 * The view a newly opened file should start in, or `undefined` when the file
 * has no rendered view and hosts keep their raw fallback. Markdown, HTML and
 * Jupyter notebooks start formatted; `.csv` starts as a table. Only the last
 * path segment counts, so a misleading extension on a parent directory never
 * changes the result.
 */
export function defaultFileViewMode(path: string): FileViewMode | undefined {
  const name = lastPathSegment(path);
  const kind = resolveFileRenderKind({ path: name });
  if (kind === 'markdown' || kind === 'html') return 'preview';
  if (fileExtension(name) === 'csv') return 'table';
  if (isNotebookPath(name)) return 'preview';
  return undefined;
}
