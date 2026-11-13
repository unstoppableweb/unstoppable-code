import type { WorkerFilesystemFileReadResult } from '@canopy/protocol/canopy-core';
import type { FileContentCanonicalRead, FileContentResponse } from './types';

/**
 * Projections of `worker.filesystem.file.read` onto the legacy
 * `file:read-content` shapes the Files panel and viewer take. Browser-safe, so
 * Electron main and the renderer's cloud file source project one way.
 */
export interface FileContentRead {
  readonly result: WorkerFilesystemFileReadResult;
  /** The file's modification time in ms; main passes its handle's exact `mtimeMs`. */
  readonly modifiedAtMs: number;
}

export function missingFileContent(filename: string): FileContentResponse {
  return {
    kind: 'missing',
    content: '',
    filename,
    sizeBytes: 0,
    truncated: false,
    modifiedAtMs: 0,
  };
}

/** The legacy `file:read-content` response for one engine read. */
export function projectLegacyFileContent(
  read: FileContentRead,
): FileContentResponse {
  const { result, modifiedAtMs } = read;
  const common = {
    filename: result.name,
    sizeBytes: result.sizeBytes,
    modifiedAtMs,
  };
  if (result.contentKind === 'image' && result.mediaType !== undefined)
    return {
      kind: 'image',
      content: `data:${result.mediaType};base64,${result.content}`,
      truncated: false,
      ...common,
    };
  if (result.contentKind === 'image' || result.contentKind === 'unsupported')
    return { kind: 'unsupported', content: '', truncated: false, ...common };
  return {
    kind: result.contentKind,
    content: result.content,
    truncated: result.truncated,
    ...common,
  };
}

/** The canonical read the Files panel consumes, without its content. */
export function canonicalFileContent(
  result: WorkerFilesystemFileReadResult,
): FileContentCanonicalRead {
  return {
    fileRootId: result.fileRootId,
    relativePath: result.relativePath,
    name: result.name,
    contentKind: result.contentKind,
    sizeBytes: result.sizeBytes,
    returnedBytes: result.returnedBytes,
    truncated: result.truncated,
    modifiedAt: result.modifiedAt,
    version: result.version,
    ...(result.mediaType !== undefined && { mediaType: result.mediaType }),
  };
}
